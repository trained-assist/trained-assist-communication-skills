import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const bindings = process.env.INTEGRATION_BINDINGS_FILE
  ? JSON.parse(readFileSync(process.env.INTEGRATION_BINDINGS_FILE, 'utf8'))
  : process.env;
const base = bindings.COMMUNICATION_API_URL;
const token = bindings.COMMUNICATION_TOKEN;
assert.ok(base && token, 'COMMUNICATION_API_URL and COMMUNICATION_TOKEN are required');
const runId = `communication-v1-${randomUUID()}`;
const report = { runId, startedAt: new Date().toISOString(), scenarios: [] };
const options = [
  {
    id: 'system_health',
    description: 'Проверить фактическое состояние компонентов системы и сообщить доступность.',
    applicability: 'Только вопрос о работоспособности. Не подходит, если пользователь также просит выполнить другую задачу.',
  },
  {
    id: 'catalog.brief',
    description: 'Рассказать об актуальных возможностях системы и доступных интеграциях.',
    applicability: 'Только вопрос о возможностях. Не подходит для просьбы выполнить действие или обработать данные.',
  },
  {
    id: 'agent',
    description: 'Выполнить пользовательскую задачу агентом с инструментами, сохранив все ограничения.',
    applicability: 'Обработка таблиц или файлов, внешние действия, составной запрос, уточнение неизвестной задачи. Не подходит для простого вопроса о состоянии или возможностях системы.',
  },
];

async function request(path, body, authenticated = true) {
  const headers = { 'content-type': 'application/json' };
  if (authenticated) headers.authorization = `Bearer ${token}`;
  const started = performance.now();
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: response.status, data: await response.json(), latencyMs: Math.round(performance.now() - started) };
}

async function rpc(method, params) {
  return request('/mcp', { jsonrpc: '2.0', id: randomUUID(), method, params });
}

async function record(name, operation) {
  try {
    const evidence = await operation();
    const scenario = { name, outcome: 'pass', ...evidence };
    report.scenarios.push(scenario);
    console.log(JSON.stringify(scenario));
  } catch (error) {
    const scenario = { name, outcome: 'fail', reason: error instanceof assert.AssertionError ? error.message : 'transport_or_provider_error' };
    report.scenarios.push(scenario);
    console.log(JSON.stringify(scenario));
    process.exitCode = 1;
  }
}

await record('health', async () => {
  const response = await request('/health', undefined, false);
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'ready');
  return { latencyMs: response.latencyMs, version: response.data.version };
});
await record('unauthorized-mcp', async () => {
  const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, false);
  assert.equal(response.status, 401);
  return { latencyMs: response.latencyMs };
});
await record('tools-list', async () => {
  const response = await rpc('tools/list');
  assert.equal(response.status, 200);
  const tools = response.data.result?.tools ?? [];
  assert.ok(tools.some(tool => tool.name === 'generate_next_message_to_conversation_partner'));
  const resolver = tools.find(tool => tool.name === 'resolve_user_intent');
  assert.ok(resolver);
  assert.equal(resolver.outputSchema.properties.decision.enum, undefined);
  return { latencyMs: response.latencyMs, methods: tools.map(tool => tool.name) };
});

for (const [name, text, expected] of [
  ['health-question', 'Работает?', 'system_health'],
  ['capabilities-question', 'Что ты умеешь?', 'catalog.brief'],
  ['health-paraphrase', 'Ты сейчас на связи и можешь отвечать?', 'system_health'],
  ['compound-task', 'Работает? Тогда прочитай таблицу расходов, найди дубли и создай отдельный лист с итогами.', 'agent'],
]) {
  await record(name, async () => {
    const response = await rpc('tools/call', {
      name: 'resolve_user_intent',
      arguments: {
        request_id: `${runId}:${name}`,
        trace_id: runId,
        input_bundle: { id: `${runId}:${name}`, version: 'v1', events: [{ id: 'message-1', type: 'text', author: 'user', text }] },
        recipient: { role: 'Помощник trained-assist' },
        decision_options: options,
        dialog_context: { history: [], active_tasks: [] },
        options: { language: 'ru' },
      },
    });
    assert.equal(response.status, 200);
    assert.ok(!response.data.error, 'MCP returned a protocol error');
    const result = response.data.result;
    assert.ok(!result?.isError, `resolver failed: ${result?.structuredContent?.error?.code ?? 'unknown'}`);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['decision', 'user_goal']);
    assert.equal(result.structuredContent.decision, expected);
    return { latencyMs: response.latencyMs, decision: result.structuredContent.decision, requestId: `${runId}:${name}` };
  });
}

report.finishedAt = new Date().toISOString();
if (process.env.INTEGRATION_REPORT_FILE) writeFileSync(process.env.INTEGRATION_REPORT_FILE, JSON.stringify(report, null, 2));
