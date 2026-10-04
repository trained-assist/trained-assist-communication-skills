'use strict';

// The intent handler: validation, the ladder call, the repair budget, typed errors,
// and the two-field answer. The ladder is stubbed by replacing globalThis.fetch, so
// these tests run offline and still exercise the REAL client code path (URL, body,
// response_format, error mapping) — the same trick the sandbox uses over a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveUserIntent,
  normalizeIntent,
  intentInputMetrics,
  collectIntentWarnings,
  INTENT_MAX_ATTEMPTS,
  INTENT_MAX_INPUT_CHARS,
  INTENT_MAX_DECISION_OPTIONS,
  INTENT_MAX_OPTIONS_CHARS,
  INTENT_CONTRACT_VERSION,
  INTENT_PROMPT_VERSION,
  NO_MATCHING_OPTION,
} from '../src/intent-handler.mjs';

const ENV = { LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'tok' };

const CATALOG = [
  { id: 'quick_llm_reply', description: 'Сформулировать ответ на основе доступного контекста без внешних действий и поиска актуальных данных' },
  { id: 'start_opencode', description: 'Запустить OpenCode для выполнения пользовательской задачи' },
];

function validArgs(overrides = {}) {
  return {
    request_id: 'r-1',
    input_bundle: {
      id: 'b-42',
      version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'Посмотри резюме и подбери вакансии. Пока не откликайся.' }],
    },
    recipient: { role: 'Карьерный помощник', persona: 'Помогаю анализировать опыт и искать работу' },
    decision_options: CATALOG,
    ...overrides,
  };
}

// ───────────────────────── ladder stub ─────────────────────────

function stubLadder({ replies, onCall } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (onCall) onCall(calls.length, body);
    const next = replies.length > 1 ? replies[calls.length - 1] : replies[0];
    if (!next) throw new Error('stubLadder: нет ответа для вызова');
    if (next.throw) throw next.throw;
    if (next.status && next.status !== 200) {
      return new Response(JSON.stringify({ error: { message: next.message || 'upstream failure' } }), { status: next.status });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl',
      model: next.model || 'fake/gemini-3.1-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: next.content }, finish_reason: 'stop' }],
      usage: next.usage || { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const OK = { user_goal: 'Подобрать актуальные вакансии по резюме, не отправляя отклики', decision: 'start_opencode' };

// ───────────────────────── вход ─────────────────────────

test('не-объект входа → VALIDATION_ERROR', async () => {
  const r = await resolveUserIntent(null, ENV);
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
});

test('обязательные поля: input_bundle, recipient, decision_options — все три перечисляются', async () => {
  const r = await resolveUserIntent({}, ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  const problems = r.data.error.problems.join(' | ');
  assert.match(problems, /input_bundle/);
  assert.match(problems, /recipient/);
  assert.match(problems, /decision_options/);
});

test('пустой список решений отклоняется: метод не придумывает варианты', async () => {
  const r = await resolveUserIntent(validArgs({ decision_options: [] }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /НЕПУСТОЙ/);
});

test('no_matching_option нельзя передать как пользовательский id', async () => {
  const r = await resolveUserIntent(validArgs({
    decision_options: [{ id: NO_MATCHING_OPTION, description: 'Ничего не подходит' }],
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /зарезервирован сервисом/);
});

test('повторяющиеся id вариантов отклоняются', async () => {
  const r = await resolveUserIntent(validArgs({
    decision_options: [
      { id: 'a', description: 'Первый вариант решения' },
      { id: 'a', description: 'Второй вариант решения' },
    ],
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /повторяется/);
});

test('описание-название недостаточно для выбора', async () => {
  const r = await resolveUserIntent(validArgs({
    decision_options: [{ id: 'Decision 3', description: 'Decision 3' }],
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  const problems = r.data.error.problems.join(' | ');
  assert.match(problems, /название, а не описание/);
});

test('короткое описание отклоняется как название', async () => {
  const r = await resolveUserIntent(validArgs({
    decision_options: [{ id: 'x', description: 'Ответить' }],
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /название, а не описание/);
});

test('decision_priority с чужим id отклоняется', async () => {
  const r = await resolveUserIntent(validArgs({ decision_priority: ['start_opencode', 'stop_task'] }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /stop_task/);
});

test('пустой пакет без событий и вложений отклоняется: цель выводить не из чего', async () => {
  const r = await resolveUserIntent(validArgs({
    input_bundle: { id: 'b-1', version: 'v1', events: [] },
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /нет ни событий, ни вложений/);
});

test('id вложения не может совпадать с id события', async () => {
  const r = await resolveUserIntent(validArgs({
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи файл' }],
      attachments: [{ id: 'e1', name: 'a.pdf', content_status: 'metadata_only' }],
    },
  }), ENV);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.match(r.data.error.problems.join(' '), /совпадает с id события/);
});

test('model_profile вне allowlist → MODEL_PROFILE_NOT_ALLOWED', async () => {
  const r = await resolveUserIntent(validArgs({ model_profile: 'turbo' }), ENV);
  assert.equal(r.data.error.code, 'MODEL_PROFILE_NOT_ALLOWED');
  assert.deepEqual(r.data.error.allowlist, ['default']);
});

test('вход больше лимита → INPUT_TOO_LARGE с размерами, без молчаливого slice', async () => {
  const r = await resolveUserIntent(validArgs({
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'x'.repeat(INTENT_MAX_INPUT_CHARS + 1) }],
    },
  }), ENV);
  assert.equal(r.data.error.code, 'INPUT_TOO_LARGE');
  assert.equal(r.data.error.sizes.limit_chars, INTENT_MAX_INPUT_CHARS);
});

test('слишком много вариантов → явная ошибка, а не тихое удаление', async () => {
  const many = Array.from({ length: INTENT_MAX_DECISION_OPTIONS + 1 }, (_, i) => ({
    id: `opt_${i}`,
    description: `Вариант решения номер ${i} с содержательным описанием`,
  }));
  const r = await resolveUserIntent(validArgs({ decision_options: many }), ENV);
  assert.equal(r.data.error.code, 'TOO_MANY_DECISION_OPTIONS');
});

test('слишком длинные описания вариантов → явная ошибка бюджета', async () => {
  const r = await resolveUserIntent(validArgs({
    decision_options: [{ id: 'a', description: 'x'.repeat(INTENT_MAX_OPTIONS_CHARS + 1) }],
  }), ENV);
  assert.equal(r.data.error.code, 'TOO_MANY_DECISION_OPTIONS');
  assert.ok(r.data.error.options_chars > INTENT_MAX_OPTIONS_CHARS);
});

// ───────────────────────── успех ─────────────────────────

test('успех: ровно два поля, диагностика отдельно в meta', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, false);
    assert.deepEqual(Object.keys(r.data).sort(), ['decision', 'user_goal']);
    assert.equal(r.data.decision, 'start_opencode');
    assert.equal(r.data.user_goal, OK.user_goal);
    assert.equal(r.meta.request_id, 'r-1');
    assert.equal(r.meta.bundle.id, 'b-42');
    assert.equal(r.meta.bundle.version, 'v1');
    assert.equal(r.meta.generation.attempts, 1);
    assert.equal(r.meta.generation.contract_version, INTENT_CONTRACT_VERSION);
    assert.equal(r.meta.generation.prompt_version, INTENT_PROMPT_VERSION);
    assert.equal(r.meta.usage.source, 'ladder');
    assert.equal(r.meta.input_metrics.decision_options, 2);
    assert.equal(r.meta.input_metrics.coverage.truncated, false);
    assert.equal(r.meta.input_metrics.coverage.events_passed, 1);
    assert.equal(r.meta.input_metrics.coverage.decision_options_passed, 2);
  } finally { stub.restore(); }
});

test("резолвер идёт в classify-лестницу, а не в conversation лестницу writer'а", async () => {
  // Это не вкусовое решение, а разные задачи: writer пишет текст человеку,
  // резолвер выбирает id из закрытого списка. У conversation первые ранг-и
  // платные OpenRouter, где осознанно ловится 402 (19% отказов за 24 ч);
  // service:classify — free-first и с нулём сбоев.
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    await resolveUserIntent(validArgs(), ENV);
    assert.equal(stub.calls[0].body.model, 'service:classify');
  } finally { stub.restore(); }
});

test('имя лестницы переопределяется для сравнения моделей (issue #10 §7)', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  const saved = process.env.LLM_LADDER_NAME;
  try {
    process.env.LLM_LADDER_NAME = 'conversation';
    const { INTENT_LADDER_NAME } = await import('../src/intent-handler.mjs?ladder-override');
    assert.equal(INTENT_LADDER_NAME, 'conversation');
  } finally {
    if (saved === undefined) delete process.env.LLM_LADDER_NAME; else process.env.LLM_LADDER_NAME = saved;
    stub.restore();
  }
});

test('запрос уходит в общую лестницу с json_schema и нулевой температурой', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    await resolveUserIntent(validArgs(), ENV);
    assert.equal(stub.calls.length, 1);
    const { url, body } = stub.calls[0];
    assert.equal(url, 'http://ladder.test/v1/chat/completions');
    assert.equal(body.model, 'service:classify');
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.properties.decision.enum, ['quick_llm_reply', 'start_opencode', NO_MATCHING_OPTION]);
    assert.deepEqual(body.response_format.json_schema.schema.required, ['user_goal', 'decision']);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.ladder_timeout_ms, 20000);
  } finally { stub.restore(); }
});

test('в промпт доходят все id вариантов и отрицание пользователя', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    await resolveUserIntent(validArgs({
      input_bundle: {
        id: 'b-42', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Посмотри резюме и подбери вакансии. Пока не откликайся.' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', mime_type: 'application/pdf', content_status: 'metadata_only' }],
      },
    }), ENV);
    const prompt = stub.calls[0].body.messages.map((m) => m.content).join('\n');
    assert.ok(prompt.includes('id=quick_llm_reply'));
    assert.ok(prompt.includes('id=start_opencode'));
    assert.ok(prompt.includes('Пока не откликайся'));
    assert.ok(prompt.includes('resume.pdf'));
    assert.ok(prompt.includes('СОДЕРЖИМОЕ НЕДОСТУПНО'));
  } finally { stub.restore(); }
});

test('замена каталога меняет enum в запросе без изменения кода', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify({ user_goal: 'Ответить по базе знаний', decision: 'answer_from_kb' }) }] });
  try {
    const r = await resolveUserIntent(validArgs({
      decision_options: [
        { id: 'answer_from_kb', description: 'Ответить на вопрос по базе знаний без внешних действий' },
        { id: 'open_ticket', description: 'Открыть обращение в службу поддержки' },
      ],
    }), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.data.decision, 'answer_from_kb');
    const { schema } = stub.calls[0].body.response_format.json_schema;
    assert.deepEqual(schema.properties.decision.enum, ['answer_from_kb', 'open_ticket', NO_MATCHING_OPTION]);
  } finally { stub.restore(); }
});

test('ответ в ограждении и в прозе разбирается', async () => {
  const stub = stubLadder({ replies: [{ content: '```json\n{"user_goal":"Подобрать вакансии","decision":"start_opencode"}\n```' }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.data.decision, 'start_opencode');
  } finally { stub.restore(); }
});

// ───────────────────────── guard + бюджет ─────────────────────────

test('невалидный ответ → ровно одна ремонтная попытка с причиной, всего 2 вызова', async () => {
  const stub = stubLadder({
    replies: [
      { content: JSON.stringify({ user_goal: 'Подобрать вакансии', decision: 'stop_task' }) },
      { content: JSON.stringify(OK) },
    ],
  });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.data.decision, 'start_opencode');
    assert.equal(stub.calls.length, 2);
    const second = stub.calls[1].body.messages.at(-1).content;
    assert.match(second, /отклонена проверкой/);
    assert.match(second, /stop_task/);
    assert.equal(r.meta.generation.attempts, 2);
  } finally { stub.restore(); }
});

test('guard отклоняет на обеих попытках → INTENT_REJECTED с причинами, не больше 2 вызовов', async () => {
  const stub = stubLadder({
    replies: [
      { content: JSON.stringify({ user_goal: 'Подобрать вакансии и созвониться в 15:30', decision: 'start_opencode' }) },
      { content: JSON.stringify({ user_goal: 'Подобрать вакансии и созвониться в 16:45', decision: 'start_opencode' }) },
    ],
  });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'INTENT_REJECTED');
    assert.equal(stub.calls.length, INTENT_MAX_ATTEMPTS);
    assert.equal(r.data.error.attempts, INTENT_MAX_ATTEMPTS);
    assert.ok(Array.isArray(r.data.error.rejections));
    assert.equal(r.data.error.rejections[0].verdict, 'invented_time');
  } finally { stub.restore(); }
});

test('выдуманное содержимое непрочитанного файла → ремонт, затем успех', async () => {
  const stub = stubLadder({
    replies: [
      { content: JSON.stringify({ user_goal: 'В файле написано, что опыт 5 лет', decision: 'start_opencode' }) },
      { content: JSON.stringify({ user_goal: 'Перевести приложенный файл резюме на английский', decision: 'start_opencode' }) },
    ],
  });
  try {
    const r = await resolveUserIntent(validArgs({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи резюме' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', content_status: 'metadata_only' }],
      },
    }), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.data.user_goal, 'Перевести приложенный файл резюме на английский');
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});

test('не-JSON ответ лестницы → ремонтная попытка, затем ошибка бюджета', async () => {
  const stub = stubLadder({ replies: [{ content: 'я не json вообще' }, { content: 'и снова не json' }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'INTENT_REJECTED');
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});

// ───────────────────────── ошибки ─────────────────────────

test('недоступная лестница → LLM_UNAVAILABLE, это техническая ошибка, а не no_matching_option', async () => {
  const stub = stubLadder({ replies: [{ status: 503, message: 'upstream down' }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'LLM_UNAVAILABLE');
    assert.notEqual(r.data?.decision, NO_MATCHING_OPTION);
  } finally { stub.restore(); }
});

test('сетевой сбой лестницы → LLM_UNAVAILABLE', async () => {
  const stub = stubLadder({ replies: [{ throw: new TypeError('fetch failed') }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'LLM_UNAVAILABLE');
  } finally { stub.restore(); }
});

test('нет ladder-конфига → LLM_UNAVAILABLE с причиной', async () => {
  const r = await resolveUserIntent(validArgs(), {});
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'LLM_UNAVAILABLE');
});

// ───────────────────────── телеметрия и границы ─────────────────────────

test('телеметрия содержит только счётчики и id — ни текста диалогов', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    const r = await resolveUserIntent(validArgs(), ENV);
    const meta = JSON.stringify(r.meta);
    assert.ok(!meta.includes('Посмотри резюме'), 'текст пользователя попал в диагностику');
    assert.ok(!meta.includes('Пока не откликайся'));
    assert.ok(meta.includes('start_opencode'), 'выбранный id — это метка решения, не PII');
  } finally { stub.restore(); }
});

test('resource_ref чужого tenant не открывается: единственный fetch — лестница', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    await resolveUserIntent(validArgs({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи файл' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', resource_ref: 'artifact:tenant-999:resume-1', content_status: 'metadata_only' }],
      },
    }), ENV);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'http://ladder.test/v1/chat/completions');
  } finally { stub.restore(); }
});

test('версия пакета возвращается в диагностике — вызывающая сторона видит устаревший результат', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    const r = await resolveUserIntent(validArgs({ input_bundle: { id: 'b-42', version: 'v7', events: [{ id: 'e1', type: 'text', author: 'user', text: 'Подбери вакансии' }] } }), ENV);
    assert.equal(r.meta.bundle.version, 'v7');
    assert.equal(r.meta.bundle.id, 'b-42');
  } finally { stub.restore(); }
});

test('trace_id возвращается как есть', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    const r = await resolveUserIntent(validArgs({ trace_id: 'trace-abc' }), ENV);
    assert.equal(r.meta.trace_id, 'trace-abc');
  } finally { stub.restore(); }
});

test('вложение, объявленное доступным без текста, даёт warning, а не молчаливую потерю', async () => {
  const stub = stubLadder({ replies: [{ content: JSON.stringify(OK) }] });
  try {
    const r = await resolveUserIntent(validArgs({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Прочитай файл' }],
        attachments: [{ id: 'a1', name: 'a.pdf', content_status: 'text_available' }],
      },
    }), ENV);
    assert.equal(r.isError, false);
    assert.equal(r.meta.warnings.length, 1);
    assert.equal(r.meta.warnings[0].code, 'attachment_text_declared_missing');
    assert.equal(r.meta.warnings[0].attachment, 'a1');
  } finally { stub.restore(); }
});

test('intentInputMetrics считает покрытие честно', () => {
  const m = intentInputMetrics(normalizeIntent(validArgs({
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'a' }, { id: 'e2', type: 'text', author: 'assistant', text: 'b' }],
      attachments: [{ id: 'a1', name: 'a.pdf', content_status: 'metadata_only' }],
    },
    capabilities: [{ id: 'c', title: 't', description: 'd' }],
    dialog_context: { history: [{ text: 'h' }], active_tasks: [{ goal: 'g' }] },
  })));
  assert.equal(m.events, 2);
  assert.equal(m.attachments, 1);
  assert.equal(m.capabilities, 1);
  assert.equal(m.history_messages, 1);
  assert.equal(m.active_tasks, 1);
  assert.equal(m.coverage.events_passed, 2);
  assert.equal(m.coverage.attachments_passed, 1);
  assert.equal(m.coverage.decision_options_passed, 2);
  assert.equal(m.coverage.truncated, false);
});

test('collectIntentWarnings не ругается на корректный ввод', () => {
  assert.deepEqual(collectIntentWarnings(normalizeIntent(validArgs())), []);
});
