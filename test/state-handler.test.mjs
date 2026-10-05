'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractConversationState,
  normalizeStateInput,
  stateInputMetrics,
  STATE_CONTRACT_VERSION,
  STATE_MAX_ATTEMPTS,
} from '../src/state-handler.mjs';

const ENV = { LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'tok' };

const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['constraints'],
  properties: {
    constraints: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'source_message_id'],
        properties: {
          quote: { type: 'string', maxLength: 400 },
          source_message_id: { type: 'string' },
        },
      },
    },
  },
};

function validArgs(overrides = {}) {
  return {
    request_id: 'r-state-1',
    trace_id: 't-state-1',
    conversation_revision: 'history-v7',
    conversation_history: {
      format: 'messages',
      messages: [
        { id: 'm1', speaker: 'sender', text: 'Подскажите опыт с Python?' },
        { id: 'm2', speaker: 'partner', text: 'Да, 5 лет. Но переезд не рассматриваю.' },
      ],
    },
    state_schema: STATE_SCHEMA,
    options: { language: 'ru' },
    ...overrides,
  };
}

function stubLadder({ replies, onCall } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (onCall) onCall(calls.length, body);
    const next = replies.length > 1 ? replies[calls.length - 1] : replies[0];
    if (!next) throw new Error('stubLadder: no reply');
    if (next.status && next.status !== 200) {
      return new Response(JSON.stringify({ error: { message: next.message || 'upstream failure' } }), { status: next.status });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl',
      model: next.model || 'fake/classify',
      choices: [{ index: 0, message: { role: 'assistant', content: next.content }, finish_reason: 'stop' }],
      usage: next.usage || { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('normalizeStateInput rejects unsupported state_schema before model call', () => {
  assert.throws(
    () => normalizeStateInput(validArgs({ state_schema: { ...STATE_SCHEMA, oneOf: [] } })),
    /extract_conversation_state/,
  );
});

test('stateInputMetrics reports full history and no truncation in MVP', () => {
  const m = stateInputMetrics(normalizeStateInput(validArgs()));
  assert.equal(m.history_messages, 2);
  assert.equal(m.coverage.history_full, true);
  assert.equal(m.coverage.truncated, false);
  assert.ok(m.schema_chars > 0);
});

test('success: extracts state, echoes revision, sends strict schema to ladder', async () => {
  const output = { state: { constraints: [{ quote: 'переезд не рассматриваю', source_message_id: 'm2' }] } };
  const stub = stubLadder({ replies: [{ content: JSON.stringify(output) }] });
  try {
    const r = await extractConversationState(validArgs(), ENV);
    assert.equal(r.isError, false);
    assert.deepEqual(r.data.state, output.state);
    assert.equal(r.data.request_id, 'r-state-1');
    assert.equal(r.data.conversation_revision, 'history-v7');
    assert.equal(r.data.generation.contract_version, STATE_CONTRACT_VERSION);
    assert.equal(r.data.generation.attempts, 1);
    assert.equal(r.meta.conversation_revision, 'history-v7');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].body.model, 'service:classify');
    assert.equal(stub.calls[0].body.reasoning_effort, 'low');
    assert.equal(stub.calls[0].body.response_format.json_schema.schema.required[0], 'state');
  } finally { stub.restore(); }
});

test('invalid model output gets one repair attempt, then succeeds', async () => {
  const stub = stubLadder({
    replies: [
      { content: JSON.stringify({ state: { constraints: [{ quote: 'x', source_message_id: 'm2', extra: true }] } }) },
      { content: JSON.stringify({ state: { constraints: [{ quote: 'x', source_message_id: 'm2' }] } }) },
    ],
  });
  try {
    const r = await extractConversationState(validArgs(), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.data.generation.attempts, 2);
    assert.equal(stub.calls.length, STATE_MAX_ATTEMPTS);
    assert.match(stub.calls[1].body.messages.at(-1).content, /Previous attempt failed validation/);
  } finally { stub.restore(); }
});

test('invalid output after retry returns STATE_REJECTED', async () => {
  const bad = { state: { constraints: [{ quote: 'x', source_message_id: 'm2', extra: true }] } };
  const stub = stubLadder({ replies: [{ content: JSON.stringify(bad) }] });
  try {
    const r = await extractConversationState(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'STATE_REJECTED');
    assert.equal(r.data.error.attempts, STATE_MAX_ATTEMPTS);
  } finally { stub.restore(); }
});

test('ladder failure is not converted into empty state', async () => {
  const stub = stubLadder({ replies: [{ status: 503, message: 'down' }] });
  try {
    const r = await extractConversationState(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'LLM_UNAVAILABLE');
    assert.equal(r.data.state, undefined);
  } finally { stub.restore(); }
});
