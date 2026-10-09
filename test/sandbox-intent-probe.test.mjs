import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
const token = 'synthetic-diagnostic-token-0123456789';
const requestId = '12345678-1234-1234-1234-123456789abc';
const env = { DEPLOYMENT_ENV: 'sandbox', SANDBOX_INTENT_PROBE_ENABLED: 'true', SANDBOX_PROBE_TOKEN: token,
  COMMUNICATION_TOKEN: 'synthetic-general-caller', LLM_LADDER_URL: 'http://fixture-ladder', LLM_LADDER_TOKEN: 'synthetic-ladder-token', BUILD_SHA: 'a'.repeat(40) };
const request = (body = { requestId }, supplied = token, path = '/internal/sandbox/intent-probe') => new Request('https://fixture.test' + path,
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + supplied }, body: JSON.stringify(body) });
test('probe credential is restricted to the fixed sandbox diagnostic, before model calls', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    for (const [config, req, status] of [[{ ...env, DEPLOYMENT_ENV: 'production' }, request(), 404],
      [{ ...env, SANDBOX_INTENT_PROBE_ENABLED: 'false' }, request(), 404], [env, request({}, 'wrong'), 401],
      [env, request({ requestId, input: 'arbitrary user content' }), 400], [env, request({}, token, '/mcp'), 401]]) {
      assert.equal((await worker.fetch(req, config)).status, status);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('real handler probe uses fixed input and correlation while returning no model text or secrets', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ model: 'fixture-model',
    choices: [{ message: { content: JSON.stringify({ user_goal: 'Проверить доступность самого помощника', decision: 'system_health' }) } }] }); };
  try {
    const response = await worker.fetch(request(), env), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.ok, true); assert.equal(body.attempts, 1);
    assert.deepEqual(body.sideEffects, { modelMayHaveBeenCalled: true, agentStarted: false, messageSent: false, cpTaskCreated: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['x-ladder-trace'], requestId);
    assert.equal(JSON.parse(calls[0].init.body).reasoning_effort, 'low');
    const serialized = JSON.stringify(body);
    for (const value of [token, env.LLM_LADDER_TOKEN, 'Проверить доступность самого помощника', 'fixture-model']) assert.equal(serialized.includes(value), false);
  } finally { globalThis.fetch = original; }
});
test('dependency rejection stays a typed outcome without raw upstream details', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('private-upstream-detail', { status: 503 });
  try {
    const response = await worker.fetch(request(), env), body = await response.json();
    assert.equal(response.status, 502); assert.equal(body.code, 'LLM_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('private-upstream-detail'), false);
  } finally { globalThis.fetch = original; }
});
