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

test('MCP tools/list отдаёт ровно один канонический инструмент со схемой', async () => {
  const res = await call('/mcp', { method: 'POST', headers: authed(), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const { result } = await res.json();
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, 'generate_next_message_to_conversation_partner');
  assert.ok(result.tools[0].inputSchema.required.includes('goal'));
  // The description must say it drafts and does not send — that is the contract.
  assert.match(result.tools[0].description, /does not send/i);
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
