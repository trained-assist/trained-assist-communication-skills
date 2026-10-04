'use strict';

// The Worker door (src/index.mjs): routing, auth, status mapping, MCP over HTTP.
// The handler is exercised separately; here we prove the TRANSPORT is correct —
// an unauthenticated call must never reach a writer, and a domain status must
// never be dressed up as HTTP 200.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const TOKEN = 'test-token-abc';
const ENV = { COMMUNICATION_TOKEN: TOKEN, LLM_LADDER_URL: 'http://127.0.0.1:1/nope', LLM_LADDER_TOKEN: 'x' };

const authed = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra });

function call(path, init = {}) {
  return worker.fetch(new Request(`https://example.test${path}`, init), ENV);
}

const VALID_BODY = {
  goal: { instruction: 'Поздоровайтесь' },
  communication_style: { instructions: 'Коротко' },
  language: 'ru',
  conversation_history: { format: 'messages', messages: [] },
};

test('GET /health — публичный, без токена, и честно сообщает readiness', async () => {
  const res = await call('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.ladder_configured, true);
  assert.ok(body.contract_version);
});

test('health без ladder-конфига → 503 not_configured, а не «ok»', async () => {
  const res = await worker.fetch(new Request('https://example.test/health'), { COMMUNICATION_TOKEN: TOKEN });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'not_configured');
});

test('без Authorization → 401 на /v1, тело с машинным кодом', async () => {
  const res = await call('/v1/dialogs/next-message', { method: 'POST', body: JSON.stringify(VALID_BODY) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
});

test('неверный токен → 401', async () => {
  const res = await call('/v1/dialogs/next-message', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  });
  assert.equal(res.status, 401);
});

test('POST /v1/dialogs/next-message без тела → 400 INVALID_INPUT, не 500', async () => {
  const res = await call('/v1/dialogs/next-message', { method: 'POST', headers: authed(), body: '{ broken' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_INPUT');
});

test('валидация → HTTP 400 с кодом VALIDATION_ERROR', async () => {
  const res = await call('/v1/dialogs/next-message', {
    method: 'POST', headers: authed(), body: JSON.stringify({ goal: {} }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.problems.length >= 1);
});

test('GET на POST-эндпоинт → 405', async () => {
  const res = await call('/v1/dialogs/next-message', { headers: authed() });
  assert.equal(res.status, 405);
});

test('неизвестный путь → 404 NOT_FOUND', async () => {
  const res = await call('/nope', { headers: authed() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('MCP initialize через HTTP отдаёт сервер и протокол', async () => {
  const res = await call('/mcp', {
    method: 'POST', headers: authed(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.serverInfo.name, 'trained-assist-communication-skills');
  assert.ok(body.result.capabilities.tools);
});

test('MCP tools/list отдаёт канонические инструменты со схемами', async () => {
  const res = await call('/mcp', { method: 'POST', headers: authed(), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const { result } = await res.json();
  assert.equal(result.tools.length, 4);
  assert.deepEqual(result.tools.map((t) => t.name), ['generate_next_message_to_conversation_partner', 'extract_conversation_state', 'evaluate_next_goal', 'resolve_user_intent']);
  for (const t of result.tools) {
    assert.ok(t.inputSchema && t.description, `${t.name}: нужны inputSchema и description`);
  }
  const state = result.tools.find((t) => t.name === 'extract_conversation_state');
  assert.deepEqual(state.outputSchema.required, ['state']);
  assert.equal(state.outputSchema.additionalProperties, false);
  assert.match(state.description, /Does not choose the next goal/i);
  const goal = result.tools.find((t) => t.name === 'evaluate_next_goal');
  assert.deepEqual(goal.outputSchema.required.slice(0, 4), ['status', 'requires_message', 'goal', 'reason']);
  // The resolver's output schema is the two-field contract, published for clients.
  const intent = result.tools.find((t) => t.name === 'resolve_user_intent');
  assert.deepEqual(intent.outputSchema.required, ['user_goal', 'decision']);
  assert.equal(intent.outputSchema.additionalProperties, false);
  assert.match(intent.description, /does not execute the selected decision/i);
});

test('MCP Accept: text/event-stream → SSE-кадрирование', async () => {
  const res = await call('/mcp', {
    method: 'POST',
    headers: authed({ accept: 'application/json, text/event-stream' }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const text = await res.text();
  assert.match(text, /^event: message\ndata: \{/);
});

test('MCP notification → 202 без тела', async () => {
  const res = await call('/mcp', { method: 'POST', headers: authed(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(res.status, 202);
});

test('MCP неизвестный метод → JSON-RPC -32601', async () => {
  const res = await call('/mcp', { method: 'POST', headers: authed(), body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope' }) });
  assert.equal((await res.json()).error.code, -32601);
});

test('MCP tools/call с кривым JSON → -32700, не 500', async () => {
  const res = await call('/mcp', { method: 'POST', headers: authed(), body: '{ broken' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test('GET /mcp → 405 (сервер не инициирует сообщений)', async () => {
  const res = await call('/mcp', { headers: authed() });
  assert.equal(res.status, 405);
});

test('tools/call отдаёт isError + типизированный код при недоступной лестнице', async () => {
  // LLM_LADDER_URL points at a closed port, so this exercises the real error path.
  const res = await call('/mcp', {
    method: 'POST', headers: authed(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'generate_next_message_to_conversation_partner', arguments: VALID_BODY } }),
  });
  const { result } = await res.json();
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'LLM_UNAVAILABLE');
});

test('contact ban через HTTP → 200 со статусом no_message_needed и draft=null', async () => {
  const res = await call('/v1/dialogs/next-message', {
    method: 'POST', headers: authed(),
    body: JSON.stringify({
      ...VALID_BODY,
      conversation_history: {
        format: 'messages',
        messages: [
          { speaker: 'sender', text: 'Давайте созвонимся' },
          { speaker: 'partner', text: 'Больше не пишите мне' },
        ],
      },
    }),
  });
  // A contact ban is a successful, terminal ANSWER — not an HTTP error.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'no_message_needed');
  assert.equal(body.message_text, null);
  assert.equal(body.dialog_state.do_not_contact, true);
});

test('нет COMMUNICATION_TOKEN → 500 NOT_CONFIGURED, а не молчаливый 401', async () => {
  const res = await worker.fetch(new Request('https://example.test/v1/dialogs/next-message', { method: 'POST' }), {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'NOT_CONFIGURED');
});

// ───────────────────────── /v1/intents/resolve (issue #10) ─────────────────────────

const INTENT_ARGS = {
  request_id: 'r-intent-1',
  input_bundle: {
    id: 'b-42',
    version: 'v1',
    events: [{ id: 'e1', type: 'text', author: 'user', text: 'Посмотри резюме и подбери вакансии. Пока не откликайся.' }],
  },
  recipient: { role: 'Карьерный помощник', persona: 'Помогаю анализировать опыт и искать работу' },
  decision_options: [
    { id: 'quick_llm_reply', description: 'Сформулировать ответ на основе доступного контекста без внешних действий и поиска актуальных данных' },
    { id: 'start_opencode', description: 'Запустить OpenCode для выполнения пользовательской задачи' },
  ],
};

const INTENT_OK = { user_goal: 'Подобрать актуальные вакансии по резюме, не отправляя отклики', decision: 'start_opencode' };

const STATE_ARGS = {
  request_id: 'r-state-1',
  conversation_revision: 'history-v7',
  conversation_history: {
    format: 'messages',
    messages: [
      { id: 'm1', speaker: 'sender', text: 'Подскажите опыт с Python?' },
      { id: 'm2', speaker: 'partner', text: 'Да, 5 лет. Но переезд не рассматриваю.' },
    ],
  },
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['constraints'],
    properties: {
      constraints: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quote', 'source_message_id'],
          properties: {
            quote: { type: 'string' },
            source_message_id: { type: 'string' },
          },
        },
      },
    },
  },
};

const STATE_OK = { state: { constraints: [{ quote: 'переезд не рассматриваю', source_message_id: 'm2' }] } };
const GOAL_ARGS = {
  request_id: 'r-goal-1', conversation_revision: 'history-v7',
  conversation_state: { constraints: [{ quote: 'переезд не рассматриваю', source_message_id: 'm2' }] },
  conversation_objective: 'Понять, подходит ли кандидат по опыту работы с CRM',
};

/** Stub the shared ladder so the REST door can be exercised end to end, offline. */
function stubLadder(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const next = replies.length > 1 ? replies[calls.length - 1] : replies[0];
    if (next.status && next.status !== 200) {
      return new Response(JSON.stringify({ error: { message: next.message || 'upstream failure' } }), { status: next.status });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl',
      model: 'fake/gemini-3.1-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: next.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('POST /v1/intents/resolve без токена → 401', async () => {
  const res = await call('/v1/intents/resolve', { method: 'POST', body: JSON.stringify(INTENT_ARGS) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
});

// ───────────────────────── /v1/conversations/state/extract (epic #11) ─────────

test('POST /v1/conversations/next-goal без токена → 401', async () => {
  const res = await call('/v1/conversations/next-goal', { method: 'POST', body: JSON.stringify(GOAL_ARGS) });
  assert.equal(res.status, 401);
});

test('POST /v1/conversations/next-goal: open goal and revision through REST', async () => {
  const stub = stubLadder([{ content: '{"status":"goal_ready","goal":{"instruction":"Уточните опыт работы с CRM и основные задачи"}}' }]);
  try {
    const res = await call('/v1/conversations/next-goal', { method: 'POST', headers: authed(), body: JSON.stringify(GOAL_ARGS) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'goal_ready');
    assert.equal(body.requires_message, true);
    assert.equal(body.goal.instruction, 'Уточните опыт работы с CRM и основные задачи');
    assert.equal(body.conversation_revision, 'history-v7');
    assert.equal(res.headers.get('x-contract-version'), 'v1');
  } finally { stub.restore(); }
});

test('MCP tools/call evaluate_next_goal: terminal wait returns no writer goal', async () => {
  const stub = stubLadder([{ content: '{"status":"wait"}' }]);
  try {
    const res = await call('/mcp', {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'evaluate_next_goal', arguments: GOAL_ARGS } }),
    });
    const { result } = await res.json();
    assert.equal(result.structuredContent.status, 'wait');
    assert.equal(result.structuredContent.requires_message, false);
    assert.equal(result.structuredContent.goal, null);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test('POST /v1/conversations/state/extract без токена → 401', async () => {
  const res = await call('/v1/conversations/state/extract', { method: 'POST', body: JSON.stringify(STATE_ARGS) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
});

test('GET /v1/conversations/state/extract → 405', async () => {
  const res = await call('/v1/conversations/state/extract', { headers: authed() });
  assert.equal(res.status, 405);
});

test('POST /v1/conversations/state/extract с unsupported schema → 400 VALIDATION_ERROR', async () => {
  const res = await call('/v1/conversations/state/extract', {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ ...STATE_ARGS, state_schema: { ...STATE_ARGS.state_schema, oneOf: [] } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
});

test('POST /v1/conversations/state/extract: echoes conversation_revision for stale-result guard', async () => {
  const stub = stubLadder([{ content: JSON.stringify(STATE_OK) }]);
  try {
    const res = await call('/v1/conversations/state/extract', { method: 'POST', headers: authed(), body: JSON.stringify(STATE_ARGS) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.state, STATE_OK.state);
    assert.equal(body.conversation_revision, 'history-v7');
    assert.equal(res.headers.get('x-contract-version'), 'v1');
    const diag = JSON.parse(res.headers.get('x-communication-diagnostics'));
    assert.equal(diag.conversation_revision, 'history-v7');
    assert.equal(diag.input_metrics.coverage.truncated, false);
    assert.ok(!res.headers.get('x-communication-diagnostics').includes('Подскажите опыт'));
  } finally { stub.restore(); }
});

test('MCP tools/call extract_conversation_state: structuredContent has state and _meta diagnostics', async () => {
  const stub = stubLadder([{ content: JSON.stringify(STATE_OK) }]);
  try {
    const res = await call('/mcp', {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'extract_conversation_state', arguments: STATE_ARGS } }),
    });
    const { result } = await res.json();
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.state, STATE_OK.state);
    assert.equal(result.structuredContent.conversation_revision, 'history-v7');
    assert.equal(result._meta.conversation_revision, 'history-v7');
  } finally { stub.restore(); }
});

test('GET /v1/intents/resolve → 405', async () => {
  const res = await call('/v1/intents/resolve', { headers: authed() });
  assert.equal(res.status, 405);
});

test('POST /v1/intents/resolve без тела → 400 INVALID_INPUT', async () => {
  const res = await call('/v1/intents/resolve', { method: 'POST', headers: authed(), body: '{ broken' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_INPUT');
});

test('POST /v1/intents/resolve с пустым списком решений → 400 VALIDATION_ERROR', async () => {
  const res = await call('/v1/intents/resolve', {
    method: 'POST', headers: authed(), body: JSON.stringify({ ...INTENT_ARGS, decision_options: [] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
});

test('POST /v1/intents/resolve: тело — ровно два поля, диагностика в заголовках', async () => {
  const stub = stubLadder([{ content: JSON.stringify(INTENT_OK) }]);
  try {
    const res = await call('/v1/intents/resolve', { method: 'POST', headers: authed(), body: JSON.stringify(INTENT_ARGS) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['decision', 'user_goal']);
    assert.equal(body.decision, 'start_opencode');
    assert.equal(res.headers.get('x-contract-version'), 'v1');
    assert.equal(res.headers.get('x-communication-request-id'), 'r-intent-1');
    const diag = JSON.parse(res.headers.get('x-communication-diagnostics'));
    assert.equal(diag.bundle.id, 'b-42');
    assert.equal(diag.bundle.version, 'v1');
    assert.equal(diag.decision, 'start_opencode');
    assert.equal(diag.input_metrics.decision_options, 2);
    assert.equal(diag.input_metrics.coverage.truncated, false);
    assert.equal(diag.usage.source, 'ladder');
    // Ни текста пользователя, ни содержимого вложений в транспортном контексте.
    const raw = res.headers.get('x-communication-diagnostics');
    assert.ok(!raw.includes('Посмотри резюме'));
  } finally { stub.restore(); }
});

test('POST /v1/intents/resolve: недоступная лестница → 503, а не no_matching_option', async () => {
  const stub = stubLadder([{ status: 503, message: 'upstream down' }]);
  try {
    const res = await call('/v1/intents/resolve', { method: 'POST', headers: authed(), body: JSON.stringify(INTENT_ARGS) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'LLM_UNAVAILABLE');
    assert.equal(body.decision, undefined);
  } finally { stub.restore(); }
});

test('POST /v1/intents/resolve: невалидный ответ модели → 422 INTENT_REJECTED', async () => {
  const stub = stubLadder([
    { content: JSON.stringify({ user_goal: 'Подобрать вакансии', decision: 'stop_task' }) },
    { content: JSON.stringify({ user_goal: 'Подобрать вакансии', decision: 'stop_task' }) },
  ]);
  try {
    const res = await call('/v1/intents/resolve', { method: 'POST', headers: authed(), body: JSON.stringify(INTENT_ARGS) });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'INTENT_REJECTED');
  } finally { stub.restore(); }
});

test('MCP tools/call resolve_user_intent: structuredContent — два поля, диагностика в _meta', async () => {
  const stub = stubLadder([{ content: JSON.stringify(INTENT_OK) }]);
  try {
    const res = await call('/mcp', {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'resolve_user_intent', arguments: INTENT_ARGS } }),
    });
    const { result } = await res.json();
    assert.equal(result.isError, undefined);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['decision', 'user_goal']);
    assert.equal(result.structuredContent.decision, 'start_opencode');
    assert.equal(result._meta.request_id, 'r-intent-1');
    assert.equal(result._meta.bundle.version, 'v1');
    assert.equal(result._meta.generation.attempts, 1);
    // Текст пользователя не попадает ни в ответ, ни в _meta.
    assert.ok(!JSON.stringify(result).includes('Посмотри резюме'));
  } finally { stub.restore(); }
});

test('MCP tools/call resolve_user_intent с чужим каталогом → другой enum в ответе', async () => {
  const stub = stubLadder([{ content: JSON.stringify({ user_goal: 'Ответить по базе знаний', decision: 'answer_from_kb' }) }]);
  try {
    const res = await call('/mcp', {
      method: 'POST', headers: authed(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: {
          name: 'resolve_user_intent',
          arguments: {
            ...INTENT_ARGS,
            decision_options: [
              { id: 'answer_from_kb', description: 'Ответить на вопрос по базе знаний без внешних действий' },
              { id: 'open_ticket', description: 'Открыть обращение в службу поддержки' },
            ],
          },
        },
      }),
    });
    const { result } = await res.json();
    assert.equal(result.structuredContent.decision, 'answer_from_kb');
  } finally { stub.restore(); }
});

test('MCP tools/call неизвестного инструмента → UNKNOWN_TOOL', async () => {
  const res = await call('/mcp', {
    method: 'POST', headers: authed(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } }),
  });
  const { result } = await res.json();
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'UNKNOWN_TOOL');
});
