import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntent, resolveUserIntent, INTENT_MAX_DECISION_OPTIONS } from '../src/intent-handler.mjs';
import { renderIntentPrompt } from '../src/intent-prompt.mjs';
import { buildDecisionOutputSchema, validateIntentOutput } from '../src/intent-schema.mjs';
import worker from '../src/index.mjs';

const names = [
  'browser_session_remote_url', 'web_current_page', 'playbook_check_reachability',
  'list_published_pages', 'hermes_run_task', 'hermes_web_research',
];

function input(decisionOptions = names.map(id => ({ id }))) {
  return {
    input_bundle: { id: 'names-only', events: [{ id: 'message', type: 'text', author: 'user', text: 'Покажи текущую страницу браузера, ничего не меняй.' }] },
    recipient: { role: 'Помощник с зарегистрированными методами' },
    decision_options: decisionOptions,
  };
}

test('actual renamed methods render only their names without synthesized descriptions', () => {
  const original = input();
  assert.equal(normalizeIntent(original), original);
  const prompt = renderIntentPrompt(original).messages[1].content;
  const section = prompt.split('# Варианты решения')[1].split('# Правила ответа')[0];
  assert.deepEqual(section.split('\n').filter(line => line.startsWith('- id=')), names.map(name => `- id=${name}`));
  assert.doesNotMatch(section, /undefined|null|применимо, когда:/);
  assert.ok(original.decision_options.every(option => !Object.hasOwn(option, 'description')));
});

test('legacy descriptions and applicability survive a mixed names-only list', () => {
  const described = { id: 'legacy route', description: 'Ответить из проверенной базы знаний', applicability: 'Только вопрос без внешних действий' };
  const original = input([{ id: 'web_current_page' }, described]);
  normalizeIntent(original);
  const prompt = renderIntentPrompt(original).messages[1].content;
  assert.ok(prompt.includes('- id=web_current_page\n'));
  assert.ok(prompt.includes(`- id=${described.id}: ${described.description}`));
  assert.ok(prompt.includes(`применимо, когда: ${described.applicability}`));
});

test('names-only handler keeps the actual per-request enum and exact two-field output', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, request) => {
    calls.push(JSON.parse(request.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ user_goal: 'Показать текущую страницу браузера без изменений', decision: 'web_current_page' }) } }] });
  };
  try {
    const result = await resolveUserIntent(input(), { LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'offline' });
    assert.equal(result.isError, false);
    assert.deepEqual(Object.keys(result.data).sort(), ['decision', 'user_goal']);
    assert.equal(result.data.decision, 'web_current_page');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].response_format.json_schema.schema.properties.decision.enum, [...names, 'no_matching_option']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a replacement names-only list cannot reuse an earlier request enum', () => {
  assert.deepEqual(buildDecisionOutputSchema(names).properties.decision.enum, [...names, 'no_matching_option']);
  const next = ['connect'];
  assert.deepEqual(buildDecisionOutputSchema(next).properties.decision.enum, ['connect', 'no_matching_option']);
  assert.equal(validateIntentOutput({ user_goal: 'Открыть текущую страницу браузера', decision: 'web_current_page' }, next).ok, false);
  assert.equal(validateIntentOutput({ user_goal: 'Не удалось выбрать подходящий метод', decision: 'no_matching_option' }, next).ok, true);
});

for (const transport of ['REST', 'MCP']) {
  test(`${transport} names-only request preserves the two-field public response`, async () => {
    const originalFetch = globalThis.fetch;
    const answer = { user_goal: 'Показать текущую страницу браузера без изменений', decision: 'web_current_page' };
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    try {
      const payload = transport === 'REST' ? input() : { jsonrpc: '2.0', id: 'names-request', method: 'tools/call', params: { name: 'resolve_user_intent', arguments: input() } };
      const path = transport === 'REST' ? '/v1/intents/resolve' : '/mcp';
      const response = await worker.fetch(new Request(`https://worker.test${path}`, {
        method: 'POST', headers: { authorization: 'Bearer offline', 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload),
      }), { COMMUNICATION_TOKEN: 'offline', LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'offline' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(transport === 'REST' ? body : body.result.structuredContent, answer);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('names-only refuses a model-selected method absent from the caller list', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ user_goal: 'Показать текущую страницу браузера без изменений', decision: 'invented_method' }) } }] });
  };
  try {
    const result = await resolveUserIntent(input(), { LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'offline' });
    assert.equal(result.isError, true);
    assert.equal(result.data.error.code, 'INTENT_REJECTED');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const invalid of ['', ' ', 42, null, 'tool name', 'tool\nname', 'инструмент', '1tool', 'tool/name', 'a'.repeat(201)]) {
  test(`invalid names-only ID is refused: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => normalizeIntent(input([{ id: invalid }])), error => error.code === 'VALIDATION_ERROR');
  });
}

test('names-only IDs remain unique after trimming and reserve no_matching_option', () => {
  for (const options of [[{ id: 'web_current_page' }, { id: ' web_current_page ' }], [{ id: 'no_matching_option' }]]) {
    assert.throws(() => normalizeIntent(input(options)), error => error.code === 'VALIDATION_ERROR');
  }
});

test('names-only accepts the full bounded list and refuses overflow without truncation', () => {
  const options = Array.from({ length: INTENT_MAX_DECISION_OPTIONS }, (_, index) => ({ id: `registered_method_${index}` }));
  const original = input(options);
  assert.equal(normalizeIntent(original).decision_options.length, INTENT_MAX_DECISION_OPTIONS);
  const prompt = renderIntentPrompt(original).messages[1].content;
  for (const option of options) assert.ok(prompt.includes(`- id=${option.id}\n`));
  assert.throws(() => normalizeIntent(input([...options, { id: 'one_more' }])), error => error.code === 'TOO_MANY_DECISION_OPTIONS');
  normalizeIntent(input([{ id: 'a'.repeat(200) }]));
});

test('provided malformed descriptions still fail instead of silently becoming names-only', () => {
  for (const description of [undefined, null, '', 'short', 'web_current_page']) {
    assert.throws(() => normalizeIntent(input([{ id: 'web_current_page', description }])), error => error.code === 'VALIDATION_ERROR');
  }
});
