'use strict';

// SANDBOX HARNESS — communication-skills.
//
// One command walks the E2E scenario of the epic through REAL functional blocks:
//
//   harness ──spawn/stdin JSON-RPC──▶ src/mcp/entrypoint.mjs   (the real MCP server)
//                                        │
//                                        ├─▶ shared llm-ladder client (POST /v1/chat/completions)
//                                        │        ▲
//   harness ──HTTP──▶ fake-ladder.mjs ────┘        (real socket, scripted, no model, no token)
//                                        │
//                                        └─▶ generate + guard (evaluate_message_quality)
//
// Nothing here calls the handler in-process: the only door is MCP tools/call, so a green
// run really means the contract works through the wire.
//
// Exit code: 0 = every scenario check passed, 1 = at least one failed.
// Run `node scripts/sandbox/harness.mjs --expect-red` to assert the CURRENT stage of the
// plan (sandbox built, feature not implemented yet → self-check green, scenario red).

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeLadder } from './fake-ladder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENTRYPOINT = process.env.COMMUNICATION_MCP_ENTRYPOINT
  ? path.resolve(process.env.COMMUNICATION_MCP_ENTRYPOINT)
  : path.join(ROOT, 'src', 'mcp', 'entrypoint.mjs');
const PROBE = path.join(HERE, 'probe-entrypoint.mjs');
const CALL_TIMEOUT_MS = Number(process.env.SANDBOX_CALL_TIMEOUT_MS || 45000);

const OVERSIZED_FILLER = 'Ответ очень длинный. '.repeat(20000); // ~380k chars

// ───────────────────────── tiny check runner ─────────────────────────

const checks = [];
function record(section, title, ok, detail = '') {
  checks.push({ section, title, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${title}${detail ? `\n      → ${detail}` : ''}`);
  return ok;
}
function fatal(title, detail) {
  record('сценарий', title, false, detail);
}

// ───────────────────────── MCP stdio client ─────────────────────────

class McpClient {
  constructor(command, args, env) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.stdoutRaw = '';
    this.exited = null;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.proc.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const [, entry] of this.pending) entry.reject(new Error(`entrypoint exited early (code=${code} signal=${signal}) stderr: ${this.stderr.trim().slice(0, 400)}`));
      this.pending.clear();
    });
    this.proc.stdout.on('data', (chunk) => {
      this.stdoutRaw += chunk;
      let nl;
      while ((nl = this.stdoutRaw.indexOf('\n')) >= 0) {
        const line = this.stdoutRaw.slice(0, nl).trim();
        this.stdoutRaw = this.stdoutRaw.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      }
    });
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms; stderr: ${this.stderr.trim().slice(0, 400)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload, (err) => { if (err) reject(err); });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  kill() {
    try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ───────────────────────── tools/call result normalisation ─────────────────────────

function deepFindCode(node, code, seen = new Set()) {
  if (node === null || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => deepFindCode(n, code, seen));
  for (const [k, v] of Object.entries(node)) {
    if (v === code) return true;
    if (deepFindCode(v, code, seen)) return true;
  }
  return false;
}

function deepHasKey(node, key, seen = new Set()) {
  if (node === null || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => deepHasKey(n, key, seen));
  for (const [k, v] of Object.entries(node)) {
    if (k === key) return true;
    if (deepHasKey(v, key, seen)) return true;
  }
  return false;
}

/** tools/call → { isError, data, meta, text } where data is the JSON payload if the server sent one. */
function unpack(result) {
  const isError = result?.isError === true;
  const structured = result?.structuredContent ?? null;
  let data = structured;
  const texts = (result?.content || [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  if (data === null) {
    for (const t of texts) {
      try { data = JSON.parse(t); break; } catch { /* not json */ }
    }
  }
  if (data === null) data = { _raw_text: texts.join('\n') };
  return { isError, data, meta: result?._meta ?? null, text: texts.join('\n') };
}

// ───────────────────────── ladder call counting ─────────────────────────

async function ladderCalls(ladder) {
  const res = await fetch(`${ladder.url}/__calls`);
  const body = await res.json();
  return body.count || 0;
}

// The fake ladder records every request it served, prompts included — that is what
// lets a scenario assert on what the WRITER actually saw.
async function fetchPrompts(ladder) {
  const res = await fetch(`${ladder.url}/__calls`);
  const body = await res.json();
  return Array.isArray(body.calls) ? body.calls : [];
}

async function setUpLadderScripts(fixtures) {
  return startFakeLadder({ scenarios: fixtures.ladder_script });
}

// ───────────────────────── scenarios ─────────────────────────

function materialise(node) {
  if (typeof node === 'string') return node.replaceAll('__FILLER__', OVERSIZED_FILLER);
  if (Array.isArray(node)) return node.map(materialise);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = materialise(v);
    return out;
  }
  return node;
}

/**
 * The assertion engine of the sandbox: given one tools/call result, return the list of
 * violated expectations (empty = check passed). Separated from the transport so the
 * self-check can prove the engine itself is not vacuous before the handler exists.
 */
function evaluateExpectations(exp, data, isError, calls, text = '', prompts = [], meta = null, rawCalls = []) {
  const problems = [];

  if (exp.ladder_calls !== undefined && calls !== exp.ladder_calls) {
    problems.push(`вызовов лестницы ${calls}, ожидалось ${exp.ladder_calls}`);
  }
  if (exp.typed_code && !deepFindCode(data, exp.typed_code)) {
    problems.push(`нет типизированного кода ${exp.typed_code} в ответе (isError=${isError}, data=${JSON.stringify(data).slice(0, 220)})`);
  }
  if (exp.is_error !== undefined && isError !== exp.is_error) {
    problems.push(`isError=${isError}, ожидалось ${exp.is_error}`);
  }

  // resolve_user_intent отдаёт ровно два поля; compose_next_message прячет текст
  // в message.text. Обе формы должны проверяться одинаково, иначе «черновик
  // пуст» для compose стал бы невыразимым.
  const messageText = data && (data.message_text ?? data.message?.text ?? (data.result && data.result.message_text));
  if (exp.status && (!data || data.status !== exp.status)) {
    problems.push(`status=${JSON.stringify(data && data.status)}, ожидалось "${exp.status}"`);
  }
  // resolve_user_intent: публичный ответ — ровно два поля, диагностика в _meta.
  // Проверяется и то, и другое: иначе диагностику можно было бы положить в тело
  // и остаться зелёными (issue #10 §2).
  if (exp.kind === 'intent') {
    if (exp.decision !== undefined && data?.decision !== exp.decision) {
      problems.push(`decision=${JSON.stringify(data && data.decision)}, ожидалось "${exp.decision}"`);
    }
    if (exp.user_goal_nonempty === true && !(typeof data?.user_goal === 'string' && data.user_goal.trim())) {
      problems.push('user_goal пуст');
    }
    if (exp.user_goal_nonempty === false && typeof data?.user_goal === 'string' && data.user_goal.trim()) {
      problems.push(`user_goal неожиданно непуст: "${String(data.user_goal).slice(0, 80)}"`);
    }
    if (exp.exact_fields) {
      const keys = Object.keys(data || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...exp.exact_fields].sort())) {
        problems.push(`поля ответа ${JSON.stringify(keys)}, ожидалось ровно ${JSON.stringify(exp.exact_fields)}`);
      }
    }
    for (const f of exp.meta_fields || []) {
      if (!deepHasKey(meta, f)) problems.push(`нет диагностики ${f} в _meta`);
    }
    // The schema is a REQUEST, and a request can be dropped without failing the call.
    // Asserting it reached the provider is the only way to notice that regression.
    if (exp.response_format_json_schema && rawCalls.length) {
      const withSchema = rawCalls.filter((c) => c.response_format?.type === 'json_schema');
      if (withSchema.length !== rawCalls.length) {
        problems.push(`json_schema передан в ${withSchema.length} из ${rawCalls.length} вызовов лестницы`);
      } else {
        const enumValues = withSchema[0].response_format?.json_schema?.schema?.properties?.decision?.enum;
        if (exp.decision_enum && JSON.stringify(enumValues) !== JSON.stringify(exp.decision_enum)) {
          problems.push(`enum в схеме ${JSON.stringify(enumValues)}, ожидалось ${JSON.stringify(exp.decision_enum)}`);
        }
      }
    }
  }
  if (exp.kind === 'compose') {
    // Публичный ответ — пять полей контракта compose_next_message. Их ровно
    // пять, и шестое поле означало бы, что метод подмевает диагностику в тело.
    if (exp.exact_fields) {
      const keys = Object.keys(data || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...exp.exact_fields].sort())) {
        problems.push(`поля ответа ${JSON.stringify(keys)}, ожидалось ровно ${JSON.stringify(exp.exact_fields)}`);
      }
    }
    // message=null при не-готовом статусе — это и есть проверка, что wait не
    // создал текст для отправки.
    if (exp.message_text_nonempty === false && data?.message?.text) {
      problems.push(`message.text неожиданно непуст: "${String(data.message.text).slice(0, 80)}"`);
    }
    for (const f of exp.meta_fields || []) {
      if (!deepHasKey(meta, f)) problems.push(`нет диагностики ${f} в _meta`);
    }
    // Пояснения к не-готовому статусу — единственное, что отличает честный wait
    // от «модель промолчала». Проверять их наличие так же важно, как статус.
    const warnings = data?.warnings;
    for (const needle of exp.warnings_contains || []) {
      if (!Array.isArray(warnings) || !warnings.some((w) => String(w).includes(needle))) {
        problems.push(`в warnings нет «${needle}»`);
      }
    }
  }
  if (exp.message_text_nonempty === true && !(typeof messageText === 'string' && messageText.trim())) {
    problems.push('message_text пуст');
  }
  if (exp.message_text_nonempty === false && typeof messageText === 'string' && messageText.trim()) {
    problems.push(`message_text неожиданно непуст: "${String(messageText).slice(0, 80)}"`);
  }
  if (exp.missing_fields_nonempty && !(Array.isArray(data && data.missing_fields) && data.missing_fields.length)) {
    problems.push(`missing_fields пуст/нет: ${JSON.stringify(data && data.missing_fields)}`);
  }
  if (exp.attempts !== undefined) {
    const attempts = data && (data.generation?.attempts ?? data.attempts);
    if (attempts !== exp.attempts) problems.push(`attempts=${JSON.stringify(attempts)}, ожидалось ${exp.attempts}`);
  }
  if (exp.verdict) {
    const verdict = data && (data.verdict ?? (data.result && data.result.verdict));
    if (verdict !== exp.verdict) problems.push(`verdict=${JSON.stringify(verdict)}, ожидалось "${exp.verdict}"`);
  }
  if (exp.reasons_array) {
    const reasons = data && (data.reasons ?? (data.result && data.result.reasons));
    if (!Array.isArray(reasons)) problems.push(`reasons не массив: ${JSON.stringify(reasons)}`);
  }
  for (const f of exp.generation_fields || []) {
    if (!deepHasKey(data, f)) problems.push(`нет поля generation.${f}`);
  }
  if (exp.usage_present && !deepHasKey(data, 'usage')) problems.push('нет telemetry usage');
  for (const f of exp.absent_fields || []) {
    // Только верхний уровень: «успех ≠ отправка» про поля самого ответа, и
    // вложенный message_id в evidence цитаты — не поле ответа.
    if (data && Object.hasOwn(data, f)) problems.push(`в ответе есть поле ${f} (успех ≠ отправка)`);
  }
  // Asserts on what actually reached the WRITER. This is how "the dialog state is
  // in the prompt" is proven rather than assumed — the state layer is invisible in
  // the response, so without this a refactor could drop it and the sandbox stay green.
  for (const needle of exp.prompt_contains || []) {
    const hit = prompts.some((p) => String(p).includes(needle));
    if (!hit) problems.push(`в prompt к лестнице нет «${needle}»`);
  }
  for (const needle of exp.prompt_excludes || []) {
    if (prompts.some((p) => String(p).includes(needle))) problems.push(`в prompt к лестнице есть лишнее «${needle}»`);
  }
  if (!exp.typed_code && !data) problems.push(`нет разбираемого ответа; текст: ${String(text).slice(0, 160)}`);
  if (!exp.typed_code && exp.kind !== 'intent' && data && data.status === undefined && !problems.length) {
    problems.push(`в ответе нет status; текст: ${String(text).slice(0, 160)}`);
  }

  return problems;
}

async function runScenario(sc, client, ladder) {
  const args = materialise(sc.arguments || {});
  const before = await ladderCalls(ladder);
  const label = `${sc.id} — ${sc.title}`;
  let reply;
  try {
    reply = await client.request('tools/call', { name: sc.tool, arguments: args });
  } catch (e) {
    fatal(label, `tools/call не ответил: ${e.message}`);
    return;
  }
  if (reply.error) {
    fatal(label, `JSON-RPC error: ${reply.error.code} ${reply.error.message}`);
    return;
  }
  const { isError, data, meta, text } = unpack(reply.result);
  const after = await ladderCalls(ladder);
  // Prompts of THIS scenario's ladder calls only (slice the window we just measured),
  // so prompt_contains can assert on this call and not on a previous scenario's.
  const all = await fetchPrompts(ladder);
  const prompts = all.slice(before, after).map((c) => (Array.isArray(c.messages) ? c.messages.map((m) => m.content).join('\n') : ''));
  const problems = evaluateExpectations(sc.expect || {}, data, isError, after - before, text, prompts, meta, all.slice(before, after));
  record('сценарий', label, problems.length === 0, problems.join(' · '));
}

// ───────────────────────── self-check ─────────────────────────

async function selfCheck(fixtures) {
  console.log('\n── self-check: харнесс жив? (должен быть зелёным всегда) ──');

  const ladder = await setUpLadderScripts(fixtures);
  let ok = true;

  // 0. every scripted ladder behaviour is reachable from the fixtures — otherwise a scenario
  //    would silently hit the fake's "no scripted scenario" branch and pass for the wrong reason.
  const fixtureBlob = JSON.stringify(materialise(fixtures.scenarios)).toLowerCase();
  const unreachable = fixtures.ladder_script.filter((s) => !fixtureBlob.includes(String(s.match).toLowerCase()));
  ok = record('self-check', 'каждый сценарий фейковой лестницы достижим из фикстур', unreachable.length === 0,
    unreachable.length ? `не встречаются в фикстурах: ${unreachable.map((u) => u.match).join(' | ')}` : `${fixtures.ladder_script.length} матчей найдены`) && ok;

  // 1. fake ladder speaks the real ladder contract
  try {
    const res = await fetch(`${ladder.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sandbox-token', 'Content-Type': 'application/json', 'x-ladder-app': 'sandbox-probe' },
      body: JSON.stringify({ model: 'conversation', messages: [{ role: 'user', content: 'поздоровайтесь и представьтесь' }], temperature: 0.7, max_tokens: 800, ladder_timeout_ms: 20000 }),
    });
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    ok = record('self-check', 'фейковая лестница отвечает по контракту POST /v1/chat/completions', res.ok && typeof content === 'string' && content.length > 0,
      `HTTP ${res.status}, model=${data?.model}, content=${String(content).slice(0, 60)}…`);
  } catch (e) {
    ok = record('self-check', 'фейковая лестница отвечает по контракту POST /v1/chat/completions', false, e.message) && ok;
  }

  // 2. harness can spawn a process and speak newline-delimited JSON-RPC
  const probe = new McpClient(process.execPath, [PROBE], {});
  try {
    const init = await probe.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sandbox-harness', version: '0.0.0' } }, 10000);
    const list = await probe.request('tools/list', {}, 10000);
    const alive = init.result?.serverInfo?.name === 'sandbox-harness-probe' && Array.isArray(list.result?.tools);
    ok = record('self-check', 'харнесс умеет JSON-RPC stdio (spawn → initialize → tools/list)', alive,
      `serverInfo=${JSON.stringify(init.result?.serverInfo)}, tools=${list.result?.tools?.length ?? 'n/a'}`) && ok;
  } catch (e) {
    ok = record('self-check', 'харнесс умеет JSON-RPC stdio (spawn → initialize → tools/list)', false, e.message) && ok;
  } finally {
    probe.kill();
  }

  // 3. the assertion engine detects violations instead of rubber-stamping everything
  const GOOD = {
    status: 'generated',
    message_text: 'Добрый день! Подскажите, работали ли вы с CRM?',
    missing_fields: [],
    generation: { model: 'fake/gemini-2.5-flash', prompt_version: 'p1', contract_version: 'v1', attempts: 1 },
    usage: { input_tokens: 10, output_tokens: 20, source: 'ladder' },
  };
  const GOOD_EXPECT = {
    kind: 'generate', status: 'generated', message_text_nonempty: true, ladder_calls: 1,
    generation_fields: ['model', 'prompt_version', 'contract_version'], usage_present: true,
    absent_fields: ['sent_at', 'delivered'],
  };
  const engineCases = [
    ['корректный ответ проходит', evaluateExpectations(GOOD_EXPECT, GOOD, false, 1), (p) => p.length === 0],
    ['пустой message_text ловится', evaluateExpectations({ message_text_nonempty: true }, { ...GOOD, message_text: '  ' }, false, 0), (p) => p.some((x) => x.includes('message_text'))],
    ['неверный status ловится', evaluateExpectations({ status: 'needs_context' }, GOOD, false, 1), (p) => p.some((x) => x.includes('status'))],
    ['лишний вызов лестницы ловится', evaluateExpectations({ ladder_calls: 1 }, GOOD, false, 4), (p) => p.some((x) => x.includes('лестницы'))],
    ['пропущенный типизированный код ловится', evaluateExpectations({ typed_code: 'INPUT_TOO_LARGE' }, GOOD, false, 0), (p) => p.some((x) => x.includes('INPUT_TOO_LARGE'))],
    ['лишнее поле «отправлено» ловится', evaluateExpectations({ absent_fields: ['sent_at'] }, { ...GOOD, sent_at: '2026-10-02' }, false, 1), (p) => p.some((x) => x.includes('sent_at'))],
    ['пустой verdict ловится', evaluateExpectations({ verdict: 'repeat', reasons_array: true }, GOOD, false, 0), (p) => p.some((x) => x.includes('verdict'))],
  ];
  const broken = engineCases.filter(([, problems, pass]) => !pass(problems));
  ok = record('self-check', 'движок проверок ловит нарушения (7 синтетических кейсов)', broken.length === 0,
    broken.length ? `не сработали: ${broken.map(([n]) => n).join(' | ')}` : `${engineCases.length} кейсов: корректный проходит, остальные красные`) && ok;

  // 4. tools/call result really is unpacked (JSON in text content AND structuredContent)
  const unpackCases = [
    ['text-json', { content: [{ type: 'text', text: '{"status":"generated"}' }] }],
    ['structured', { structuredContent: { status: 'generated' } }],
  ];
  const unpacked = unpackCases.map(([n, r]) => [n, unpack(r)]);
  const unpackOk = unpacked.every(([, u]) => u.data && u.data.status === 'generated' && u.isError === false);
  ok = record('self-check', 'распаковка tools/call (text-JSON и structuredContent) работает', unpackOk,
    unpacked.map(([n, u]) => `${n}→status=${u.data && u.data.status}`).join(', ')) && ok;

  return { ladder, ok };
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const expectRed = process.argv.includes('--expect-red');
  const t0 = Date.now();
  const fixtures = JSON.parse(readFileSync(path.join(HERE, 'fixtures.json'), 'utf8'));

  console.log('ПЕСОЧНИЦА communication-skills — сценарий эпика #1 через реальные функциональные блоки');
  console.log(`уровень: S5 (замкнутый цикл локально) · entrypoint: ${path.relative(ROOT, ENTRYPOINT) || ENTRYPOINT}`);

  const { ladder, ok: selfOk } = await selfCheck(fixtures);

  console.log('\n── сценарий E2E (через MCP tools/call) ──');
  if (!existsSync(ENTRYPOINT)) {
    record('сценарий', 'entrypoint MCP существует', false,
      `${path.relative(ROOT, ENTRYPOINT)} отсутствует — handler/tools ещё не реализованы (ожидаемо на этом шаге плана)`);
  } else {
    const client = new McpClient(process.execPath, [ENTRYPOINT], {
      LLM_LADDER_URL: ladder.url,
      LLM_LADDER_TOKEN: 'sandbox-token',
      COMMUNICATION_SANDBOX: '1',
    });
    try {
      const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sandbox-harness', version: '0.0.0' } });
      const listed = await client.request('tools/list', {});
      const names = (listed.result?.tools || []).map((t) => t.name);
      const handshakeOk = record('сценарий', 'S1-mcp-handshake — initialize + tools/list отдаёт канонические инструменты со схемами',
        init.result?.serverInfo?.name === 'trained-assist-communication-skills'
        && names.includes('generate_next_message_to_conversation_partner')
        && names.includes('extract_conversation_state')
        && names.includes('evaluate_next_goal')
        && names.includes('resolve_user_intent')
        && names.includes('compose_next_message')
        && names.length === 5
        && (listed.result?.tools || []).every((t) => t.inputSchema && t.description),
        `serverInfo=${JSON.stringify(init.result?.serverInfo)}, tools=${JSON.stringify(names)}`);
      client.notify('notifications/initialized', {});

      for (const sc of fixtures.scenarios) {
        if (sc.expect?.kind === 'handshake') continue;
        if (!handshakeOk && !names.includes(sc.tool)) {
          record('сценарий', `${sc.id} — ${sc.title}`, false, `тул ${sc.tool} не объявлен в tools/list`);
          continue;
        }
        await runScenario(sc, client, ladder);
      }
    } catch (e) {
      fatal('сценарий не выполнен', e.message);
    } finally {
      client.kill();
    }
  }

  await ladder.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const scen = checks.filter((c) => c.section === 'сценарий');
  const self = checks.filter((c) => c.section === 'self-check');
  const passed = checks.filter((c) => c.ok).length;

  console.log(`\nИТОГ: ${passed}/${checks.length} проверок пройдено за ${secs}s · self-check ${self.every((c) => c.ok) ? 'ЗЕЛЁНЫЙ' : 'КРАСНЫЙ'} · сценарий ${scen.every((c) => c.ok) ? 'ЗЕЛЁНЫЙ' : 'КРАСНЫЙ'}`);

  const scenarioRed = scen.some((c) => !c.ok);
  if (expectRed) {
    if (self.every((c) => c.ok) && scenarioRed) {
      console.log('ОЖИДАЕМОЕ СОСТОЯНИЕ ЭТОГО ШАГА: харнесс зелёный, сценарий красный (фича не реализована) — цикл замкнут и проверяет.');
      return 10; // distinct code: sandbox works, feature not implemented yet
    }
    console.log('ОЖИДАНИЕ НАРУШЕНО: --expect-red требует зелёный self-check И красный сценарий.');
    return 1;
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('sandbox harness crashed:', e);
  process.exit(2);
});
