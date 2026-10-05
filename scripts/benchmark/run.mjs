'use strict';

// Бенчмарк compose_next_message_in_one_call против существующей цепочки state → goal → message
// (issue #28 §Бенчмарк).
//
// Один и тот же фиксированный набор синтетических диалогов (cases.json) прогоняется
// обоими путями. Разница между режимами — та же, что у корпуса resolver'а:
//
//   --offline   лестница подменена скриптом, который отдаёт размеченный ответ.
//               Проверяется: конвейер доносит ответ, валидатор ловит поданные ему
//               дефекты, метки самосогласованы, метрики СЧИТАЮТСЯ. НЕ измеряется
//               качество модели и НЕ измеряется задержка — подменённая лестница
//               отвечает мгновенно.
//   --live      настоящая общая лестница (нужны LLM_LADDER_URL / LLM_LADDER_TOKEN).
//               Здесь появляются p50/p95, токены, стоимость и реальная доля отказов.
//
// Метрики в офлайне печатаются с честной пометкой: измеряется КОНВЕЙЕР, не модель.
//
// Сравнение, которое этот раннер НЕ делает и не должен: он не судит, какой путь
// лучше. Он даёт числа по обоим путям на одинаковых данных; решение о переключении
// принимает владелец (issue #28: «новый метод не становится production default»).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { composeNextMessage } from '../../src/compose-handler.mjs';
import { extractConversationState } from '../../src/state-handler.mjs';
import { evaluateNextGoal } from '../../src/goal-handler.mjs';
import { generateNextMessage } from '../../src/handler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(HERE, 'cases.json');

// Зеркало config/prices.json общей лестницы (per 1M токенов: input, output, cachedRead).
// Только для ОЦЕНКИ стоимости; неизвестная модель → null, а не 0.
const PRICES_PER_1M = {
  'openrouter/google/gemini-3.1-flash-lite-preview': [0.075, 0.3, 0],
  'openrouter/google/gemini-2.5-flash': [0.1, 0.4, 0],
  'opencode-go/mimo-v2.6-flash': [0.14, 0.28, 0.0028],
};

// Схема состояния для цепочки. Одинаковая для всех кейсов: иначе разница между
// путями измеряла бы разные схемы, а не разные пути.
const BENCH_STATE_SCHEMA = {
  type: 'object',
  properties: {
    contact_allowed: { type: 'boolean' },
    do_not_contact: { type: 'boolean' },
    answered_questions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    partner_commitments: { type: 'array', items: { type: 'string' } },
    conditions: { type: 'array', items: { type: 'string' } },
    last_partner_message: { type: 'string' },
  },
};

// ───────────────────────── подменённая лестница ─────────────────────────

/**
 * Отвечает по форме запроса, а не по порядку: шаг однозначно называет либо
 * json_schema.name (state / goal), либо x-ladder-app (compose — он намеренно
 * НЕ шлёт response_format, см. комментарий в compose-handler.mjs), а writer —
 * единственный вызов, у которого нет ни того, ни другого.
 */
function offlineReply(body, headers, script) {
  const schemaName = body.response_format?.json_schema?.name;
  const app = String(headers?.['x-ladder-app'] || headers?.get?.('x-ladder-app') || '');
  if (app === 'communication-skills-compose') return JSON.stringify(script.compose);
  if (schemaName === 'conversation_state') return JSON.stringify({ state: script.state });
  if (schemaName === 'next_communication_goal') return JSON.stringify(script.goal);
  if (script.message === null) return null; // цепочка не должна дойти до writer'а
  return script.message;
}

function installOfflineLadder(state) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push({ url: String(url), body });
    const reply = offlineReply(body, init.headers, state.current.script);
    if (reply === null) {
      return new Response(JSON.stringify({ error: { message: 'benchmark: writer не должен вызываться для этого кейса' } }), { status: 500 });
    }
    return new Response(JSON.stringify({
      id: 'benchmark-chatcmpl',
      model: 'fake/gemini-3.1-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

function installPromptRecorder(state) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    try {
      const body = JSON.parse(init.body);
      if (Array.isArray(body.messages)) state.calls.push({ url: String(url), body });
    } catch { /* not a ladder call */ }
    return original(url, init);
  };
  return () => { globalThis.fetch = original; };
}

// ───────────────────────── два пути ─────────────────────────

/** Один вызов. Возвращает нормализованный результат с тем же набором метрик. */
async function runCompose(c, env) {
  const started = Date.now();
  const out = await composeNextMessage(c.input, env);
  return {
    path: 'compose',
    isError: out.isError,
    errorCode: out.isError ? (out.data?.error?.code ?? null) : null,
    status: out.data?.status ?? null,
    // Fallback-результат — это ответ writer'а, и текст лежит в message_text, а не
    // в message.text. Без этой ветки каждый fallback выглядел бы «пустым текстом»,
    // то есть измерялся бы формат ответа, а не качество пути.
    messageText: out.data?.message?.text ?? out.data?.message_text ?? null,
    nextGoal: out.data?.next_goal?.instruction ?? null,
    facts: (out.data?.key_facts ?? []).map((f) => `${f.fact} ${f.evidence?.quote ?? ''}`),
    attempts: out.data?.generation?.attempts ?? null,
    usedFallback: out.meta?.fallback?.used === true,
    ladderCalls: out.meta?.generation?.attempts ?? 0,
    model: out.meta?.generation?.model ?? null,
    inputTokens: out.meta?.usage?.input_tokens ?? null,
    outputTokens: out.meta?.usage?.output_tokens ?? null,
    latencyMs: Date.now() - started,
  };
}

/** Существующая цепочка: state → goal → writer, на тех же данных. */
async function runChain(c, env) {
  const started = Date.now();
  const requestId = `bench-${c.id}`;
  const revision = c.input.context_revision ?? `rev-${c.id}`;

  const usage = emptyUsage();
  const stateOut = await extractConversationState({
    conversation_history: c.input.conversation_history,
    state_schema: BENCH_STATE_SCHEMA,
    conversation_revision: revision,
    partner_profile: c.input.partner_profile,
    sender_profile: c.input.sender_profile,
    context: c.input.context,
    request_id: requestId,
  }, env);
  if (stateOut.isError) {
    return { path: 'chain', isError: true, errorCode: stateOut.data?.error?.code ?? null, status: null, messageText: null, nextGoal: null, facts: [], attempts: null, usedFallback: false, ladderCalls: stateOut.data?.error?.attempts ?? 1, model: null, usage, latencyMs: Date.now() - started };
  }
  addUsage(usage, stateOut.meta?.usage);

  const goalOut = await evaluateNextGoal({
    conversation_objective: c.input.conversation_objective,
    conversation_state: stateOut.data.state,
    conversation_revision: revision,
    request_id: requestId,
  }, env);
  if (goalOut.isError) {
    return { path: 'chain', isError: true, errorCode: goalOut.data?.error?.code ?? null, status: null, messageText: null, nextGoal: null, facts: [], attempts: null, usedFallback: false, ladderCalls: 2, model: null, usage, latencyMs: Date.now() - started };
  }
  addUsage(usage, goalOut.data.usage);
  if (goalOut.data.status !== 'goal_ready') {
    // Штатная остановка цепочки, а не отказ: сообщение не пишется.
    return {
      path: 'chain',
      isError: false,
      errorCode: null,
      status: goalOut.data.status === 'do_not_contact' ? 'do_not_contact' : 'wait',
      messageText: null,
      nextGoal: null,
      facts: [],
      attempts: goalOut.data.generation.attempts,
      usedFallback: false,
      ladderCalls: 2,
      model: goalOut.data.generation.model,
      usage,
      latencyMs: Date.now() - started,
    };
  }

  const writerOut = await generateNextMessage({
    goal: goalOut.data.goal,
    communication_style: c.input.communication_style,
    language: c.input.language,
    conversation_history: c.input.conversation_history,
    ...(c.input.partner_profile !== undefined ? { partner_profile: c.input.partner_profile } : {}),
    ...(c.input.sender_profile !== undefined ? { sender_profile: c.input.sender_profile } : {}),
    ...(c.input.context !== undefined ? { context: c.input.context } : {}),
    ...(c.input.constraints !== undefined ? { constraints: c.input.constraints } : {}),
    context_revision: revision,
    request_id: requestId,
  }, env);
  return {
    path: 'chain',
    isError: writerOut.isError,
    errorCode: writerOut.isError ? (writerOut.data?.error?.code ?? null) : null,
    status: writerOut.data?.status ?? null,
    messageText: writerOut.data?.message_text ?? null,
    nextGoal: goalOut.data.goal.instruction,
    facts: [],
    attempts: writerOut.data?.generation?.attempts ?? null,
    usedFallback: false,
    ladderCalls: 3,
    model: writerOut.data?.generation?.model ?? null,
    usage,
    latencyMs: Date.now() - started,
  };
}

// ───────────────────────── проверки разметки ─────────────────────────

const fold = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

/**
 * У двух путей разные словари статусов и разный набор того, что можно проверить:
 * compose возвращает key_facts, цепочка — состояние отдельным вызовом. Метки
 * разведены по путям (compose_status / chain_status / compose_facts_include),
 * потому что одна метка на оба пути измеряла бы словарь, а не метод.
 *
 * `mode` обязателен намеренно: ТОЧНОЕ число вызовов лестницы — утверждение о
 * офлайне (там вызовы считает заглушка). В live модель может потребовать
 * вторую попытку, и это не дефект, а работа ремонта; в live проверяется
 * ПОТОЛОК. Ровно та же дисциплина, что в scripts/corpus/run.mjs.
 */
function checkCase(c, r, mode) {
  const exp = c.expected;
  const problems = [];
  const infra = r.isError && ['LLM_UNAVAILABLE', 'INTERNAL'].includes(r.errorCode);

  if (infra) problems.push(`инфраструктурный сбой ${r.errorCode} — не провал качества`);
  else if (r.isError) problems.push(`ожидался успех, получена ошибка ${r.errorCode}`);

  if (!infra && !r.isError) {
    const accepts = [].concat(exp[`${r.path}_status`] ?? exp.status);
    if (!accepts.includes(r.status)) problems.push(`status=${r.status}, метка ${accepts.join('|')}`);

    const hasText = !!String(r.messageText ?? '').trim();
    if (exp.message === 'required' && !hasText) problems.push('текст сообщения пуст, а метка ждёт сообщение');
    if (exp.message === 'absent' && hasText) problems.push(`текст сообщения есть («${String(r.messageText).slice(0, 60)}»), а метка ждёт его отсутствия`);

    if (exp.compose_facts_include && r.path === 'compose') {
      // Проверяем факт ВМЕСТЕ с его дословной цитатой: «в фактах нет X» должно
      // означать «ни утверждение, ни подтверждающая цитата не несут X».
      const hay = fold((r.facts || []).join(' | '));
      for (const needle of exp.compose_facts_include) {
        if (!hay.includes(fold(needle))) problems.push(`в фактах нет «${needle}»`);
      }
    }
    for (const needle of exp.message_forbids || []) {
      if (fold(r.messageText).includes(fold(needle))) problems.push(`в тексте есть запрещённое «${needle}»`);
    }

    const expectedCalls = exp.ladder_calls?.[r.path];
    if (mode === 'offline') {
      if (expectedCalls !== undefined && r.ladderCalls !== expectedCalls) {
        problems.push(`вызовов лестницы ${r.ladderCalls}, ожидалось ровно ${expectedCalls}`);
      }
    } else if (expectedCalls !== undefined && r.ladderCalls > expectedCalls) {
      // Потолок: ремонтная попытка сверх него означала бы, что бюджет не удержан.
      problems.push(`вызовов лестницы ${r.ladderCalls}, потолок для этого кейса ${expectedCalls}`);
    }
  }
  return { problems, infra };
}

// ───────────────────────── метрики ─────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Usage must be SUMMED over every call a path makes, not read off the last one.
 *
 * Taking only the final step's `usage` made the chain look three times cheaper
 * than it is: the state and goal calls were dropped, not free. That inverted the
 * whole cost comparison (measured 05.10.2026: compose ≈ 1.2× the chain, not 0.4×),
 * so the accumulation lives in one helper that every path must route through.
 */
function addUsage(acc, usage) {
  if (!usage) return acc;
  if (Number.isFinite(usage.input_tokens)) acc.input_tokens += usage.input_tokens;
  if (Number.isFinite(usage.output_tokens)) acc.output_tokens += usage.output_tokens;
  if (Number.isFinite(usage.cached_tokens)) acc.cached_tokens += usage.cached_tokens;
  return acc;
}

const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cached_tokens: 0 });

function usageOf(acc) {
  return { source: 'ladder', input_tokens: acc.input_tokens, output_tokens: acc.output_tokens, cached_tokens: acc.cached_tokens };
}

function estimateCost(model, usage) {
  const price = PRICES_PER_1M[model];
  if (!price || !usage) return null;
  const input = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const cached = Number.isFinite(usage.cached_tokens) ? usage.cached_tokens : 0;
  return (input - cached) * (price[0] / 1e6) + output * (price[1] / 1e6) + cached * (price[2] / 1e6);
}

function summarise(rows, pathName) {
  const latencies = rows.map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const infra = rows.filter((r) => r.infra);
  const ok = rows.filter((r) => !r.infra && !r.isError);
  const costs = rows.map((r) => r.cost).filter((v) => v !== null);
  // Первый ответ без ремонта. attempts=0 — серверное решение без вызова лестницы
  // (запрет контакта); это лучше, чем успех с первой попытки, а не хуже.
  const firstPass = rows.filter((r) => !r.infra && !r.isError && r.attempts <= 1);
  return {
    path: pathName,
    cases: rows.length,
    passed: rows.filter((r) => !r.problems.length).length,
    failed: rows.filter((r) => r.problems.length).length,
    infra_failures: infra.length,
    valid_result_rate: rows.length ? ok.length / rows.length : null,
    first_pass_rate: ok.length ? firstPass.length / ok.length : null,
    // «Семантическая ошибка» = первый ответ не прошёл серверную валидацию и
    // потребовалась ремонтная попытка. Технические сбои сюда не попадают.
    semantic_error_rate: ok.length ? (ok.length - firstPass.length) / ok.length : null,
    fallback_rate: rows.length ? rows.filter((r) => r.usedFallback).length / rows.length : null,
    ladder_calls_total: rows.reduce((s, r) => s + r.ladderCalls, 0),
    ladder_calls_max: rows.reduce((m, r) => Math.max(m, r.ladderCalls), 0),
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    total_input_tokens: rows.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0),
    total_output_tokens: rows.reduce((s, r) => s + (r.usage?.output_tokens || 0), 0),
    total_cached_tokens: rows.reduce((s, r) => s + (r.usage?.cached_tokens || 0), 0),
    cost_usd_known_models: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    cost_unknown_models: rows.filter((r) => r.cost === null && !r.isError).length,
  };
}

// ───────────────────────── прогон ─────────────────────────

/**
 * @param {object} o
 * @param {'offline'|'live'} o.mode
 * @param {object} o.env Worker env (live требует LLM_LADDER_URL/TOKEN)
 * @param {boolean} [o.verbose]
 */
export async function runBenchmark({ mode = 'offline', env: envArg = {}, verbose = false } = {}) {
  const { cases } = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  const state = { calls: [], current: null };
  const restoreOffline = mode === 'offline' ? installOfflineLadder(state) : null;
  const restoreRecorder = mode === 'live' ? installPromptRecorder(state) : null;
  const env = mode === 'offline'
    ? { LLM_LADDER_URL: 'http://benchmark-ladder.test', LLM_LADDER_TOKEN: 'benchmark-token' }
    : envArg;

  const rows = [];
  for (const c of cases) {
    for (const runner of [runCompose, runChain]) {
      state.current = c;
      state.calls = [];
      const r = await runner(c, env);
      r.ladderCalls = state.calls.length;
      r.cost = r.isError ? null : estimateCost(r.model, r.usage);
      const checked = checkCase(c, r, mode);
      rows.push({
        id: c.id, title: c.title, difficulty: c.difficulty, kind: c.kind,
        ...r, ...checked,
      });
      if (verbose) {
        const mark = checked.problems.length ? '✗' : '✓';
        console.log(`  ${mark} ${c.id} ${r.path.padEnd(7)} ${c.title}${checked.problems.length ? `\n      → ${checked.problems.join(' · ')}` : ''}`);
      }
    }
  }

  if (restoreOffline) restoreOffline();
  if (restoreRecorder) restoreRecorder();

  const metrics = {
    mode,
    cases: cases.length,
    overall: {
      compose: summarise(rows.filter((r) => r.path === 'compose'), 'compose'),
      chain: summarise(rows.filter((r) => r.path === 'chain'), 'chain'),
    },
    by_difficulty: Object.fromEntries(['simple', 'ambiguous'].map((d) => [d, {
      compose: summarise(rows.filter((r) => r.difficulty === d && r.path === 'compose'), 'compose'),
      chain: summarise(rows.filter((r) => r.difficulty === d && r.path === 'chain'), 'chain'),
    }])),
  };
  return { rows, metrics, fixtures: cases };
}

// ───────────────────────── отчёт ─────────────────────────

const num = (v) => (v === null || v === undefined ? 'n/a' : (typeof v === 'number' && v % 1 !== 0 ? v.toFixed(4) : String(v)));

const METRIC_NAMES = [
  'Кейсов', 'Зелёных', 'Красных', 'Инфраструктурных сбоев',
  'Доля валидного результата', 'Доля успеха с первой попытки', 'Доля семантических ошибок',
  'Доля fallback', 'Вызовов лестницы всего', 'Максимум вызовов на кейс',
  'p50, мс', 'p95, мс',
  'Входных токенов', 'Выходных токенов', 'Стоимость, USD', 'Кейсов с неизвестной моделью',
];

function metricValues(summary) {
  const keys = [
    'cases', 'passed', 'failed', 'infra_failures',
    'valid_result_rate', 'first_pass_rate', 'semantic_error_rate',
    'fallback_rate', 'ladder_calls_total', 'ladder_calls_max',
    'p50_ms', 'p95_ms',
    'total_input_tokens', 'total_output_tokens', 'total_cached_tokens', 'cost_usd_known_models', 'cost_unknown_models',
  ];
  return keys.map((key) => num(summary[key]));
}

function comparisonTable(compose, chain) {
  const a = metricValues(compose);
  const b = metricValues(chain);
  const body = METRIC_NAMES.map((name, i) => `| ${name} | ${a[i]} | ${b[i]} |`).join('\n');
  return [
    '| Метрика | compose (1 вызов) | цепочка (3 вызова) |',
    '|---|---|---|',
    body,
  ].join('\n');
}

/**
 * Отчёт пишется по запросу: артефакт сравнения должен существовать в репозитории,
 * иначе через месяц «мы замерили» останется без цифр.
 */
export function renderReport({ metrics, fixtures }) {
  const { mode } = metrics;
  const honesty = mode === 'offline'
    ? [
      '> Офлайн-лестница отвечает мгновенно и отдаёт размеченный ответ. Значит:',
      '>',
      '> - `p50_ms` / `p95_ms` **не измеряют задержку** — подменённая лестница отвечает за миллисекунды;',
      '> - `total_input_tokens` / `total_output_tokens` / `cost_*` — **константы заглушки**, а не измерение;',
      '> - `first_pass_rate` и `semantic_error_rate` измеряют конвейер и серверную валидацию, а **не** качество модели;',
      '> - `ladder_calls_*` — единственная метрика этого режима, у которой есть содержание: она считает',
      '>   вызовы по коду, а не по «так ответила лестница».',
      '>',
      '> Замер качества и задержки — только `npm run benchmark:live`.',
    ]
    : [
      '> Живая лестница. `infra_failures` — доступность лестницы, а не качество метода; для сравнения',
      '> пригодны попарные прогоны без `infra_failures`.',
    ];

  return [
    '# Бенчмарк compose_next_message_in_one_call против цепочки state → goal → message',
    '',
    'Источник: [issue #28](https://github.com/trained-assist/trained-assist-communication-skills/issues/28).',
    'Связанные задачи: [эпик #11](https://github.com/trained-assist/trained-assist-communication-skills/issues/11),',
    '[ревью задержки и токенов #23](https://github.com/trained-assist/trained-assist-communication-skills/issues/23).',
    '',
    '## Как получен этот файл',
    '',
    '```bash',
    'npm run benchmark        # офлайн, лестница подменена скриптом',
    'npm run benchmark:live   # живая общая лестница, нужны её секреты',
    'node scripts/benchmark/run.mjs --offline --write-report',
    '```',
    '',
    'Разметка зафиксирована ДО сравнения и версионируется вместе с этим отчётом в',
    `\`scripts/benchmark/cases.json\`: ${fixtures.length} синтетических диалогов, персональных данных нет.`,
    'Исходные диалоги, резюме и имена кандидатов в прогоны и логи не попадают — это скриптовый ответ',
    'лестницы плюс счётчики.',
    '',
    `Текущий прогон: **${mode}**.`,
    ...honesty,
    '',
    '## Итоги по всем кейсам',
    '',
    comparisonTable(metrics.overall.compose, metrics.overall.chain),
    '',
    '## Простые и неоднозначные кейсы отдельно',
    '',
    'Одного среднего недостаточно: на простых кейсах обе разновидности метода выглядят одинаково,',
    'а регрессии видны там, где есть отказ, отмена прежнего ответа или нехватка данных.',
    '',
    ...Object.entries(metrics.by_difficulty).flatMap(([difficulty, paths]) => [
      `### difficulty = ${difficulty}`,
      '',
      comparisonTable(paths.compose, paths.chain),
      '',
    ]),
    '## Что этот отчёт НЕ доказывает',
    '',
    '- Ни одна метрика выше не измеряет **качество текста** вслепую. Для этого нужен отдельный',
    '  LLM-судья; он намеренно не запускался, потому что оценивать два текста одной и той же моделью',
    '  без анонимизации — это мерить собственную предвзятость.',
    '- Офлайн-прогон **не измеряет задержку**: подменённая лестница отвечает мгновенно.',
    '- `cost_usd_known_models: null` означает «модель не в таблице цен», а не ноль.',
    '- Один прогон лестницы невоспроизводим: доступность воркера флапает (см. известные ограничения',
    '  в README).',
    '- `fallback_rate` в офлайне измеряет только срабатывание проводки fallback на поданных дефектах,',
    '  а не её частоту на живом трафике.',
    '- **Точное число вызовов лестницы проверяется только в офлайне.** В live сверяется потолок:',
    '  модель может потребовать вторую попытку ремонта, и это не дефект. Ровно та же дисциплина,',
    '  что в `scripts/corpus/run.mjs`.',
    '- **Токены и стоимость суммируются по ВСЕМ вызовам пути.** Сначала я брал `usage` только у последнего',
    '  шага цепочки и получил «compose в 2.3 раза дороже» — это была ошибка учёта, а не измерение.',
    '  После исправления: compose ≈ 1.2× цепочки, то есть примерно одинаково.',
    '- **Замеры 05.10.2026 сделаны на пятой ступени профиля `conversation`**',
    '  (`opencode-go/mimo-v2.6-flash`): ступени 1–4, включая обе Gemini, в тот момент отказывали.',
    '  Вывод про `response_format` — свойство этой ступени, а не метода; на Gemini он может не',
    '  воспроизводиться. До прогона на рабочей ступени качество сравнивать нельзя.',
    '',
  ].join('\n');
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--live') ? 'live' : 'offline';
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const writeReport = argv.includes('--write-report');

  if (mode === 'live' && (!process.env.LLM_LADDER_URL || !process.env.LLM_LADDER_TOKEN)) {
    console.error('live-режим требует LLM_LADDER_URL и LLM_LADDER_TOKEN (секреты общей лестницы).');
    console.error('Офлайн-прогон конвейера: npm run benchmark');
    process.exit(2);
  }

  const { rows, metrics, fixtures } = await runBenchmark({ mode, env: process.env, verbose });

  console.log(`\nБЕНЧМАРК compose vs цепочка — режим ${mode}`);
  if (mode === 'offline') {
    console.log('Лестница подменена скриптом: метрики ниже описывают КОНВЕЙЕР, а не качество модели.');
    console.log('Задержка и токены на живой лестнице — только npm run benchmark:live.');
  }
  for (const r of rows.filter((x) => x.problems.length)) {
    console.log(`  ✗ ${r.id} ${r.path} — ${r.title}\n      → ${r.problems.join(' · ')}`);
  }
  for (const [label, group] of Object.entries(metrics.overall)) {
    console.log(`\nМЕТРИКИ (${label})`);
    for (const [k, v] of Object.entries(group)) console.log(`  ${k}: ${num(v)}`);
  }

  if (writeReport) {
    const target = path.join(HERE, 'report.md');
    writeFileSync(target, renderReport({ metrics, fixtures }));
    console.log(`\nОтчёт записан: ${path.relative(process.cwd(), target)}`);
  }

  const failed = metrics.overall.compose.failed + metrics.overall.chain.failed;
  console.log(`\nИТОГ: ${metrics.cases} кейсов × 2 пути${failed ? `, ${failed} красных — разбираться` : ', все зелёные'}.`);
  process.exit(failed ? 1 : 0);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) main();