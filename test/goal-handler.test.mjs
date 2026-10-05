'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNextGoal, normalizeGoalInput, GOAL_MAX_ATTEMPTS } from '../src/goal-handler.mjs';

const ENV = { LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'tok' };
function args(overrides = {}) {
  return {
    request_id: 'goal-1', trace_id: 'trace-1', conversation_revision: 'history-v9',
    conversation_objective: 'Понять, подходит ли кандидат по опыту работы с CRM и условиям графика',
    conversation_state: { answered_questions: ['опыт с Python'], refusals: ['не рассматривает переезд'] },
    ...overrides,
  };
}
function stubLadder(contents) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const content = contents[Math.min(calls.length - 1, contents.length - 1)];
    return new Response(JSON.stringify({ model: 'fake/classify', choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }), { status: 200 });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('requires a high-level objective and state before calling ladder', () => {
  assert.throws(() => normalizeGoalInput(args({ conversation_objective: '' })), (error) => error.code === 'VALIDATION_ERROR');
});

test('formulates an open-ended goal, permits missing reason, and echoes revision', async () => {
  const stub = stubLadder(['{"status":"goal_ready","goal":{"instruction":"Уточнить, с какими CRM кандидат работал и какие задачи в них выполнял"}}']);
  try {
    const result = await evaluateNextGoal(args(), ENV);
    assert.equal(result.isError, false);
    assert.equal(result.data.status, 'goal_ready');
    assert.equal(result.data.requires_message, true);
    assert.deepEqual(result.data.goal, { instruction: 'Уточнить, с какими CRM кандидат работал и какие задачи в них выполнял', required_points: [], forbidden_points: [] });
    assert.equal(stub.calls[0].reasoning_effort, 'low');
    assert.equal(result.data.reason, '');
    assert.equal(result.data.conversation_revision, 'history-v9');
    assert.deepEqual(stub.calls[0].response_format.json_schema.schema.properties.status.enum, ['goal_ready', 'wait', 'no_matching_option']);
    assert.match(stub.calls[0].messages.at(-1).content, /Понять, подходит ли кандидат/);
    assert.match(stub.calls[0].messages.at(-1).content, /answered_questions/);
    assert.doesNotMatch(stub.calls[0].messages.at(-1).content, /goal_options/);
  } finally { stub.restore(); }
});

test('wait is terminal: no writer goal is returned', async () => {
  const stub = stubLadder(['{"status":"wait"}']);
  try {
    const result = await evaluateNextGoal(args(), ENV);
    assert.equal(result.data.status, 'wait');
    assert.equal(result.data.requires_message, false);
    assert.equal(result.data.goal, null);
  } finally { stub.restore(); }
});

test('no_matching_option is terminal', async () => {
  const stub = stubLadder(['{"status":"no_matching_option"}']);
  try {
    const result = await evaluateNextGoal(args(), ENV);
    assert.equal(result.data.status, 'no_matching_option');
    assert.equal(result.data.requires_message, false);
    assert.equal(result.data.goal, null);
  } finally { stub.restore(); }
});

test('explicit contact ban stops before ladder and writer', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ladder must not be called'); };
  try {
    const result = await evaluateNextGoal(args({ conversation_state: { do_not_contact: { detected: true } } }), ENV);
    assert.equal(result.isError, false);
    assert.equal(result.data.status, 'do_not_contact');
    assert.equal(result.data.requires_message, false);
    assert.equal(result.data.goal, null);
    assert.equal(result.data.generation.attempts, 0);
  } finally { globalThis.fetch = original; }
});

test('invalid open goal gets one repair attempt and then succeeds', async () => {
  const stub = stubLadder(['{"status":"goal_ready","goal":{"instruction":"x"}}', '{"status":"wait","reason":""}']);
  try {
    const result = await evaluateNextGoal(args(), ENV);
    assert.equal(result.isError, false);
    assert.equal(result.data.status, 'wait');
    assert.equal(result.data.generation.attempts, GOAL_MAX_ATTEMPTS);
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].messages.at(-1).content, /Previous answer failed validation/);
  } finally { stub.restore(); }
});

test('invalid result after retry returns GOAL_REJECTED', async () => {
  const stub = stubLadder(['{"status":"unknown"}']);
  try {
    const result = await evaluateNextGoal(args(), ENV);
    assert.equal(result.isError, true);
    assert.equal(result.data.error.code, 'GOAL_REJECTED');
  } finally { stub.restore(); }
});
