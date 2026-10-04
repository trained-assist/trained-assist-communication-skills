'use strict';

// Размеченный корпус resolve_user_intent (issue #10 §9).
//
// Два режима, и разница между ними — это честность отчёта:
//
//   node scripts/corpus/run.mjs --offline   лестница подменена скриптом, который отдаёт
//                                          размеченный ответ. Проверяется: кейс валиден,
//                                          метка самосогласована, конвейер доносит ответ,
//                                          guard ловит поданные ему дефекты. НЕ проверяется
//                                          качество модели — для этого нужен живой прогон.
//   node scripts/corpus/run.mjs --live      настоящая общая лестница (нужны LLM_LADDER_URL
//                                          и LLM_LADDER_TOKEN). Здесь измеряются decision
//                                          accuracy, полнота user_goal, доля
//                                          no_matching_option, p50/p95 и стоимость.
//
// Оба режима печатают ОДИН и тот же набор метрик, но офлайн-прогон помечает их как
// «контрактные», а не «качественные». Подменять одно другим — значит выдавать зелёный
// офлайн-прогон за измерение модели.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveUserIntent } from '../../src/intent-handler.mjs';
import { NO_MATCHING_OPTION } from '../../src/intent-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(HERE, 'cases.json');

// Зеркало config/prices.json общей лестницы (per 1M токенов: input, output, cachedRead).
// Нужно только для ОЦЕНКИ стоимости в отчёте; неизвестная модель → null, а не 0
// («unknown не заменять нулём», docs/spec.md).
const PRICES_PER_1M = {
  'openrouter/google/gemini-3.1-flash-lite-preview': [0.075, 0.3, 0],
  'openrouter/google/gemini-2.5-flash': [0.1, 0.4, 0],
  'opencode-go/mimo-v2.6-flash': [0.14, 0.28, 0.0028],
};

const FILLERS = {
  __FILLER_120001__: 'x'.repeat(120001),
};

function materialise(node) {
  if (typeof node === 'string') {
    return Object.entries(FILLERS).reduce((acc, [k, v]) => acc.replaceAll(k, v), node);
  }
  if (Array.isArray(node)) return node.map(materialise);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = materialise(v);
    return out;
  }
  return node;
}

/**
 * Каталог решений подставляется в аргументы кейса: список — всегда от вызывающей стороны.
 * Кейс может переопределить список целиком (E03–E08 проверяют контрактные ошибки
 * именно на своём списке) — тогда каталог не подменяется.
 */
function buildArguments(catalogs, c) {
  const catalog = catalogs[c.catalog];
  if (!catalog) throw new Error(`кейс ${c.id}: неизвестный каталог ${c.catalog}`);
  const args = materialise(c.arguments || {});
  if (!Array.isArray(args.decision_options)) args.decision_options = catalog.decision_options;
  if (!Array.isArray(args.decision_priority) && catalog.decision_priority) args.decision_priority = catalog.decision_priority;
  return args;
}

// ───────────────────────── офлайн-лестница ─────────────────────────

/**
 * Скрипт вместо лестницы. Возвращает то, что размечено: либо размеченный ответ,
 * либо поданный дефект (для проверки guard'а), либо пару «дефект → исправление».
 *
 * Кейсы с `ladder_calls: 0` — это контрактные ошибки, где лестница НЕ должна
 * вызываться. Скрипт в этом случае падает, если его позвали: так «0 вызовов»
 * проверяется фактом, а не предположением.
 */
function offlineLadderReply(c, callIndex) {
  const exp = c.expect || {};
  if (exp.ladder_calls === 0) {
    return { httpError: { status: 500, message: `corpus: лестницу позвали, хотя кейс ${c.id} требует 0 вызовов` } };
  }
  if (exp.repair_reply) {
    if (callIndex === 1) {
      const first = exp.scripted_reply
        ? exp.scripted_reply.content
        : JSON.stringify({ user_goal: 'Подобрать вакансии и созвониться в 15:30', decision: 'start_opencode' });
      return { content: first };
    }
    return { content: exp.repair_reply.content };
  }
  if (exp.scripted_reply) {
    const r = exp.scripted_reply;
    if (r.status && r.status !== 200) return { httpError: r };
    return { content: r.content };
  }
  return { content: JSON.stringify({ user_goal: exp.reference_goal, decision: exp.decision }) };
}

function installOfflineLadder(state) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push({ url: String(url), body });
    const reply = offlineLadderReply(state.current, state.calls.length);
    if (reply.httpError) {
      return new Response(JSON.stringify({ error: { message: reply.httpError.message || 'scripted upstream failure' } }), { status: reply.httpError.status || 500 });
    }
    return new Response(JSON.stringify({
      id: 'corpus-chatcmpl',
      model: 'fake/gemini-3.1-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

// ───────────────────────── проверки ─────────────────────────

function checkCase(c, out, ladderCalls) {
  const exp = c.expect || {};
  const problems = [];

  if (exp.typed_code) {
    if (!out.isError) problems.push(`ожидался код ${exp.typed_code}, получен успех ${JSON.stringify(out.data).slice(0, 120)}`);
    else if (out.data?.error?.code !== exp.typed_code) problems.push(`код ${out.data?.error?.code}, ожидался ${exp.typed_code}`);
  } else if (out.isError) {
    problems.push(`ожидался успех, получена ошибка ${out.data?.error?.code}: ${out.data?.error?.message}`);
  }

  if (exp.ladder_calls !== undefined && ladderCalls !== exp.ladder_calls) {
    problems.push(`вызовов лестницы ${ladderCalls}, ожидалось ${exp.ladder_calls}`);
  }

  if (out.isError) return problems;

  // Публичный ответ — ровно два поля.
  const keys = Object.keys(out.data || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['decision', 'user_goal'])) {
    problems.push(`поля ответа ${JSON.stringify(keys)}, ожидалось ["decision","user_goal"]`);
  }

  const { decision, user_goal } = out.data || {};
  const accepts = exp.accepts || (exp.decision ? [exp.decision] : []);
  if (exp.decision && !accepts.includes(decision)) {
    problems.push(`decision=${decision}, метка ${accepts.join('|')}`);
  }
  if (exp.reference_goal && user_goal !== exp.reference_goal) {
    // Офлайн-режим: цель приходит из скрипта, поэтому расхождение — поломка кейса,
    // а не модели. В живом режиме цель пишет модель, и сверяется не текст, а полнота.
    problems.push(`user_goal не совпал с размеченным: «${String(user_goal).slice(0, 80)}»`);
  }
  for (const needle of exp.goal_contains || []) {
    if (!String(user_goal).toLowerCase().includes(needle.toLowerCase())) problems.push(`в user_goal нет «${needle}»`);
  }
  for (const needle of exp.goal_forbids || []) {
    if (String(user_goal).toLowerCase().includes(needle.toLowerCase())) problems.push(`в user_goal есть запрещённое «${needle}»`);
  }
  return problems;
}

// ───────────────────────── метрики ─────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function estimateCost(model, usage) {
  const price = PRICES_PER_1M[model];
  if (!price || !usage) return null;
  const input = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const output = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const cached = Number.isFinite(usage.cached_tokens) ? usage.cached_tokens : 0;
  return (input - cached) * (price[0] / 1e6) + output * (price[1] / 1e6) + cached * (price[2] / 1e6);
}

function summarise(results, mode) {
  const latencies = results.map((r) => r.timingMs).filter(Number.isFinite).sort((a, b) => a - b);
  const decisions = results.filter((r) => !r.isError);
  const accepted = decisions.filter((r) => r.accepted);
  const reserved = decisions.filter((r) => r.decision === NO_MATCHING_OPTION);
  const liveState = results.filter((r) => r.liveState);
  const liveViolations = liveState.filter((r) => r.requiresLiveFacts && r.decision !== NO_MATCHING_OPTION);
  const lostConstraints = results.reduce((sum, r) => sum + r.lostConstraints, 0);
  const costs = results.map((r) => r.cost).filter((v) => v !== null);

  return {
    mode,
    cases: results.length,
    passed: results.filter((r) => r.problems.length === 0).length,
    failed: results.filter((r) => r.problems.length > 0).length,
    // Ниже — метрики качества. В офлайн-режиме они описывают КОНТРАКТ (цель приходит
    // из скрипта), поэтому помечены как contract_*, а не как измерение модели.
    contract_decision_accuracy: decisions.length ? accepted.length / decisions.length : null,
    contract_goal_completeness: results.length
      ? results.reduce((sum, r) => sum + r.goalChecks, 0) / Math.max(1, results.reduce((sum, r) => sum + r.goalChecksTotal, 0))
      : null,
    contract_no_matching_share: decisions.length ? reserved.length / decisions.length : null,
    contract_lost_constraints: lostConstraints,
    contract_live_state_violations: liveViolations.length,
    max_ladder_calls: results.reduce((max, r) => Math.max(max, r.ladderCalls), 0),
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    total_input_tokens: results.reduce((s, r) => s + (r.inputTokens || 0), 0),
    total_output_tokens: results.reduce((s, r) => s + (r.outputTokens || 0), 0),
    cost_usd_known_models: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    cost_unknown_models: results.filter((r) => r.cost === null && !r.isError).length,
  };
}

// ───────────────────────── прогон ─────────────────────────

/**
 * @param {object} o
 * @param {'offline'|'live'} o.mode
 * @param {object} o.env Worker env (в live-режиме нужны LLM_LADDER_URL/TOKEN)
 * @param {Array<string>} [o.only] фильтр по id кейсов
 * @param {boolean} [o.verbose]
 */
export async function runCorpus({ mode = 'offline', env: envArg = {}, only = null, verbose = false } = {}) {
  const fixtures = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  const cases = only ? fixtures.cases.filter((c) => only.includes(c.id)) : fixtures.cases;
  const state = { calls: [], current: null };
  const restore = mode === 'offline' ? installOfflineLadder(state) : null;
  // Офлайн-режим обязан работать без секретов: адрес лестницы фиктивный, отвечает
  // скрипт. Живой режим берёт секреты из окружения и падает без них (см. main()).
  const env = mode === 'offline'
    ? { LLM_LADDER_URL: 'http://corpus-ladder.test', LLM_LADDER_TOKEN: 'corpus-token' }
    : envArg;

  const results = [];
  for (const c of cases) {
    state.current = c;
    state.calls = [];
    const args = buildArguments(fixtures.catalogs, c);
    const t0 = Date.now();
    const out = await resolveUserIntent(args, env);
    const timingMs = Date.now() - t0;

    const problems = checkCase(c, out, state.calls.length);
    const exp = c.expect || {};
    const goal = typeof out.data?.user_goal === 'string' ? out.data.user_goal : '';
    const goalChecksTotal = (exp.goal_contains || []).length;
    const goalChecks = (exp.goal_contains || []).filter((n) => goal.toLowerCase().includes(n.toLowerCase())).length;
    const lostConstraints = (exp.goal_contains || []).filter((n) => !goal.toLowerCase().includes(n.toLowerCase())).length;

    results.push({
      id: c.id,
      title: c.title,
      catalog: c.catalog,
      isError: out.isError,
      ladderCalls: state.calls.length,
      decision: out.data?.decision ?? null,
      accepted: !out.isError && (exp.accepts || [exp.decision]).includes(out.data.decision),
      liveState: !!exp.live_state,
      requiresLiveFacts: !!exp.requires_live_facts,
      goalChecks,
      goalChecksTotal,
      lostConstraints,
      timingMs,
      inputTokens: out.meta?.usage?.input_tokens ?? null,
      outputTokens: out.meta?.usage?.output_tokens ?? null,
      cost: out.isError ? null : estimateCost(out.meta?.generation?.model, out.meta?.usage),
      problems,
    });

    if (verbose) {
      const mark = problems.length ? '✗' : '✓';
      console.log(`  ${mark} ${c.id} — ${c.title}${problems.length ? `\n      → ${problems.join(' · ')}` : ''}`);
    }
  }

  if (restore) restore();
  return { results, metrics: summarise(results, mode) };
}

// ───────────────────────── CLI ─────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--live') ? 'live' : 'offline';
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(',').filter(Boolean) : null;

  if (mode === 'live' && (!process.env.LLM_LADDER_URL || !process.env.LLM_LADDER_TOKEN)) {
    console.error('live-режим требует LLM_LADDER_URL и LLM_LADDER_TOKEN (секреты общей лестницы).');
    console.error('Офлайн-прогон контракта: node scripts/corpus/run.mjs --offline');
    process.exit(2);
  }

  runCorpus({ mode, env: process.env, only, verbose })
    .then(({ results, metrics }) => {
      console.log(`\nКОРПУС resolve_user_intent — режим ${mode}`);
      if (mode === 'offline') {
        console.log('Лестница подменена скриптом: метрики ниже описывают КОНТРАКТ, а не качество модели.');
        console.log('Замер качества — только --live с секретами общей лестницы.');
      }
      for (const r of results.filter((x) => x.problems.length)) {
        console.log(`  ✗ ${r.id} — ${r.title}\n      → ${r.problems.join(' · ')}`);
      }
      console.log('\nМЕТРИКИ');
      for (const [k, v] of Object.entries(metrics)) {
        console.log(`  ${k}: ${v === null ? 'n/a' : (typeof v === 'number' && v % 1 !== 0 ? v.toFixed(4) : v)}`);
      }
      const failed = metrics.failed;
      console.log(`\nИТОГ: ${metrics.passed}/${metrics.cases} кейсов зелёные${failed ? `, ${failed} красные — разбираться` : ''}.`);
      process.exit(failed ? 1 : 0);
    })
    .catch((e) => { console.error('corpus runner crashed:', e); process.exit(2); });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) main();
