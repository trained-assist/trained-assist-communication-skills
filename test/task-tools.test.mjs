import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
const env = { COMMUNICATION_TOKEN: 'fixture' };
async function rpc(method, params = {}, token = 'fixture', path = '/mcp/task-tools') {
  const response = await worker.fetch(new Request(`https://example.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }),
  }), env);
  return { status: response.status, body: await response.json() };
}
test('task door requires authentication and publishes only read-only product replies', async () => {
  assert.equal((await rpc('tools/list', {}, 'wrong')).status, 401);
  const { body } = await rpc('tools/list');
  assert.deepEqual(body.result.tools.map(t => t.name), ['system_health', 'catalog.brief']);
  assert.ok(body.result.tools.every(t => t.annotations.readOnlyHint && !t.annotations.openWorldHint));
  assert.equal((await rpc('tools/call', { name: 'resolve_user_intent' })).body.result.isError, true);
  assert.equal((await rpc('tools/call', { name: 'system_health' }, 'fixture', '/mcp')).body.result.isError, true);
});
test('service acknowledgement needs no ladder, Runner or Watcher and rejects invented arguments', async () => {
  const { body } = await rpc('tools/call', { name: 'system_health', arguments: {} });
  assert.deepEqual(body.result.structuredContent, { text: 'Сервис работает! Отправляйте задание!' });
  assert.equal((await rpc('tools/call', { name: 'system_health', arguments: { command: 'probe' } })).body.result.isError, true);
});
test('catalog reply requires trusted caller context and distinguishes grants from readiness', async () => {
  assert.equal((await rpc('tools/call', { name: 'catalog.brief' })).body.result.isError, true);
  const context = { catalog: { version: 'v1', entries: [
    { id: 'fixture', title: 'Fixture', availability: 'granted_readiness_unverified' },
  ] } };
  const { body } = await rpc('tools/call', { name: 'catalog.brief', arguments: {}, _meta: { 'trained-assist/context': context } });
  assert.match(body.result.structuredContent.text, /работоспособность интеграции не проверена/);
  assert.match(body.result.structuredContent.text, /Fixture/);
});
