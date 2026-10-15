'use strict';

// next_message_in_dialogue: handler (issue #28).
//
// Три вещи, которые здесь проверяются как факт, а не как намерение:
//   1. успешный путь — РОВНО один вызов лестницы (иначе метод не то, чем
//      заявлен, и бенчмарк сравнивает не то);
//   2. запрет контакта — серверное решение, лестница не вызывается;
//   3. технический сбой запускает существующую цепочку и остаётся наблюдаемым
//      как fallback, а не маскируется под обычный ответ.

import test from 'node:test';
import assert from 'node:assert/strict';
import { composeNextMessage, COMPOSE_CONTRACT_VERSION, COMPOSE_PROMPT_VERSION } from '../src/compose-handler.mjs';

const ENV = { LLM_LADDER_URL: 'http://compose-ladder.test', LLM_LADDER_TOKEN: 'compose-token' };

const INPUT = {
  conversation_objective: 'Квалифицировать опыт кандидата с CRM',
  communication_style: { instructions: 'Ты — рекрутер. Обращение на «вы», коротко.' },
  language: 'ru',
  conversation_history: {
    format: 'messages',
    messages: [
      { id: 'm1', speaker: 'sender', text: 'Подскажите, с какими CRM вы работали?' },
      { id: 'm2', speaker: 'partner', text: 'Да, готов выполнить тестовое задание.' },
    ],
  },
  context: { vacancy: 'Менеджер по продажам, Москва' },
  constraints: { max_characters: 600, max_questions: 1 },
  // Не нужен самому compose (он формулирует цель сам), но без него цепочка
  // fallback запуститься не может — writer требует goal.
  goal: { instruction: 'Уточнить объём продаж и количество карточек', required_points: [], forbidden_points: [] },
  request_id: 'cb-1',
};

// Лестница-заглушка: считает вызовы и отвечает по скрипту. Отвечает тем, что
// просит тест, — включая дефекты, которые обязан ловить guard/валидатор.
function stubLadder({ replies, onCall } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (onCall) onCall(calls.length, body);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply && reply.httpError) {
      return new Response(JSON.stringify({ error: { message: reply.httpError.message } }), { status: reply.httpError.status || 500 });
    }
    const content = typeof reply === 'string' ? reply : (reply && reply.content) || '';
    return new Response(JSON.stringify({
      id: 'stub-chatcmpl',
      model: 'fake/gemini-2.5-flash',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function readyReply(overrides = {}) {
  return { content: JSON.stringify({
    status: 'ready',
    key_facts: [{ fact: 'Кандидат подтвердил готовность к тестовому', evidence: { quote: 'Да, готов выполнить тестовое задание.', message_id: 'm2' } }],
    next_goal: { instruction: 'Уточнить объём продаж и количество карточек', required_points: [], forbidden_points: [] },
    message: { text: 'Уточните, пожалуйста, объём продаж.', language: 'ru' },
    warnings: [],
    ...overrides,
  }) };
}

test('успешный путь: ровно один вызов лестницы и контрактный ответ', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(ladder.calls.length, 1);
    assert.equal(out.data.status, 'ready');
    assert.equal(out.data.message.text, 'Уточните, пожалуйста, объём продаж.');
    assert.equal(out.data.generation.attempts, 1);
    assert.equal(out.data.generation.contract_version, COMPOSE_CONTRACT_VERSION);
    assert.equal(out.data.generation.prompt_version, COMPOSE_PROMPT_VERSION);
    assert.equal(out.data.generation.model, 'fake/gemini-2.5-flash');
    assert.deepEqual(out.data.key_facts[0].evidence.quote, 'Да, готов выполнить тестовое задание.');
    assert.equal(out.meta.usage.input_tokens, 500);
  } finally {
    ladder.restore();
  }
});

test('в вызов НЕ уходит json_schema — замер показал, что он ломает ответ', async () => {
  // Замер 05.10.2026 на живой лестнице: с response_format на этой ступени ответ
  // 0/3 содержал key_facts вообще; без него — 3/3 корректной формы. Отправлять
  // схему «на всякий случай» здесь нельзя: она не усиливает контракт, а ломает
  // его на каждом вызове.
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    await composeNextMessage(INPUT, ENV);
    assert.equal(ladder.calls.length, 1);
    assert.equal(ladder.calls[0].body.response_format, undefined, 'compose не должен отправлять response_format');
    assert.equal(ladder.calls[0].body.model, 'conversation');
  } finally {
    ladder.restore();
  }
});

test('запрет контакта: статус do_not_contact, лестница НЕ вызывается', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage({
      ...INPUT,
      conversation_history: {
        format: 'messages',
        messages: [
          { id: 'm1', speaker: 'sender', text: 'Подскажите, с какими CRM вы работали?' },
          { id: 'm2', speaker: 'partner', text: 'Пожалуйста, не пишите мне больше.' },
        ],
      },
    }, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'do_not_contact');
    assert.equal(out.data.message, null);
    assert.equal(out.data.generation.attempts, 0);
    assert.equal(out.data.usage.source, 'none');
    assert.equal(ladder.calls.length, 0);
  } finally {
    ladder.restore();
  }
});

test('wait не создаёт текст для отправки', async () => {
  const ladder = stubLadder({ replies: [{ content: JSON.stringify({
    status: 'wait',
    key_facts: [],
    next_goal: null,
    message: null,
    warnings: ['ждём обещанный ответ кандидата'],
  }) }] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'wait');
    assert.equal(out.data.message, null);
    assert.equal(out.data.next_goal, null);
    assert.ok(out.data.warnings.some((w) => w.includes('ждём')));
    assert.equal(ladder.calls.length, 1);
  } finally {
    ladder.restore();
  }
});

test('невалидный JSON → ремонт с причиной, ровно 2 вызова, затем fallback', async () => {
  const ladder = stubLadder({ replies: [{ content: 'не json' }, readyReply()] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'ready');
    assert.equal(ladder.calls.length, 2);
    // Второму вызову обязано быть сказано, ЧТО не так — иначе он повторит ошибку.
    const second = ladder.calls[1].body.messages.at(-1).content;
    assert.ok(second.includes('не json') || second.includes('JSON'), 'во вторую попытку не передана причина отклонения');
  } finally {
    ladder.restore();
  }
});

test('выдуманная цитата отклоняется валидатором evidence', async () => {
  const ladder = stubLadder({ replies: [readyReply({
    key_facts: [{ fact: 'Кандидат просил не писать', evidence: { quote: 'больше не пишите мне' } }],
  }), readyReply()] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(ladder.calls.length, 2);
    assert.equal(out.data.status, 'ready');
    assert.ok(out.data.key_facts.length >= 1);
  } finally {
    ladder.restore();
  }
});

test('черновик, который отклонил бы guard цепочки, не пропускается и здесь', async () => {
  const reask = 'Подскажите, с какими CRM вы работали и какие задачи в них выполняли?';
  const ladder = stubLadder({ replies: [readyReply({ message: { text: reask, language: 'ru' } }), readyReply()] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(ladder.calls.length, 2);
    assert.notEqual(out.data.message.text, reask);
  } finally {
    ladder.restore();
  }
});

test('исчерпанный бюджет + fallback:"off" → типизированная ошибка, а не выдуманный текст', async () => {
  const ladder = stubLadder({ replies: [{ content: 'не json' }, { content: 'тоже не json' }] });
  try {
    const out = await composeNextMessage({ ...INPUT, fallback: 'off' }, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'COMPOSE_REJECTED');
    assert.equal(ladder.calls.length, 2);
    assert.ok(Array.isArray(out.data.error.rejections));
  } finally {
    ladder.restore();
  }
});

test('ошибка лестницы + fallback:"off" → LLM_UNAVAILABLE, это не cannot_compose', async () => {
  const ladder = stubLadder({ replies: [{ httpError: { status: 502, message: 'every rung failed' } }] });
  try {
    const out = await composeNextMessage({ ...INPUT, fallback: 'off' }, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'LLM_UNAVAILABLE');
  } finally {
    ladder.restore();
  }
});

test('ошибка лестницы → запускается существующая цепочка и помечается как fallback', async () => {
  // Цепочка: state → goal → writer. Отвечаем по форме запроса, как это делает
  // фейковая лестница песочницы: json_schema с разным name — разный шаг.
  const ladder = stubLadder({ replies: [
    { httpError: { status: 502, message: 'every rung failed' } },
    { content: JSON.stringify({ state: { contact_allowed: true, do_not_contact: false, answered_questions: [], open_questions: [], partner_commitments: [], conditions: [] } }) },
    { content: JSON.stringify({ status: 'goal_ready', goal: { instruction: 'Уточнить объём продаж и количество карточек', required_points: [], forbidden_points: [] }, reason: '' }) },
    { content: 'Уточните, пожалуйста, объём продаж.' },
  ] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'generated');
    assert.equal(out.data.message_text, 'Уточните, пожалуйста, объём продаж.');
    assert.equal(out.meta.fallback.used, true);
    assert.ok(out.meta.fallback.reason.includes('ladder_unavailable'));
    // 1 вызов compose + 3 вызова цепочки
    assert.equal(ladder.calls.length, 4);
  } finally {
    ladder.restore();
  }
});

test('fallback невозможен без writer goal → типизированная ошибка с причиной', async () => {
  const ladder = stubLadder({ replies: [{ httpError: { status: 502, message: 'every rung failed' } }] });
  try {
    const { goal, ...withoutGoal } = INPUT;
    assert.ok(goal, 'в базовом входе есть goal');
    const out = await composeNextMessage(withoutGoal, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'LLM_UNAVAILABLE');
    assert.ok(out.data.error.message.includes('цепочка'));
  } finally {
    ladder.restore();
  }
});

test('fallback с остановкой цепочки на этапе цели возвращает wait, а не текст', async () => {
  const ladder = stubLadder({ replies: [
    { httpError: { status: 502, message: 'every rung failed' } },
    { content: JSON.stringify({ state: { contact_allowed: true, do_not_contact: false } }) },
    { content: JSON.stringify({ status: 'wait', goal: null, reason: 'ждём обещанный ответ' }) },
  ] });
  try {
    const out = await composeNextMessage({ ...INPUT, goal: { instruction: 'Уточнить объём продаж и количество карточек' } }, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'wait');
    assert.equal(out.data.message, null);
    assert.equal(out.meta.fallback.used, true);
    assert.equal(out.meta.fallback.stopped_at, 'goal');
  } finally {
    ladder.restore();
  }
});

test('fallback не запускается дважды на один запрос', async () => {
  const ladder = stubLadder({ replies: [
    { content: 'не json' },
    { content: 'тоже не json' },
    { content: JSON.stringify({ state: { contact_allowed: true, do_not_contact: false } }) },
    { content: JSON.stringify({ status: 'goal_ready', goal: { instruction: 'Уточнить объём продаж и количество карточек', required_points: [], forbidden_points: [] }, reason: '' }) },
    { content: 'Уточните, пожалуйста, объём продаж.' },
  ] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    assert.equal(out.isError, false);
    assert.equal(out.data.status, 'generated');
    // 2 попытки compose + 3 вызова цепочки, а не 2 + 3 + 3
    assert.equal(ladder.calls.length, 5);
  } finally {
    ladder.restore();
  }
});

test('невалидный вход не тратит бюджет цепочки', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage({ ...INPUT, conversation_objective: '' }, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'VALIDATION_ERROR');
    assert.equal(ladder.calls.length, 0);
  } finally {
    ladder.restore();
  }
});

test('превышение лимита → INPUT_TOO_LARGE с размерами, без молчаливого slice', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage({
      ...INPUT,
      context: { vacancy: 'Менеджер по продажам, Москва. '.repeat(20000) },
    }, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'INPUT_TOO_LARGE');
    assert.ok(out.data.error.sizes.total_chars > 120000);
    assert.equal(ladder.calls.length, 0);
  } finally {
    ladder.restore();
  }
});

test('модель_profile вне allowlist отклоняется до вызова', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage({ ...INPUT, model_profile: 'gpt-x' }, ENV);
    assert.equal(out.isError, true);
    assert.equal(out.data.error.code, 'MODEL_PROFILE_NOT_ALLOWED');
    assert.equal(ladder.calls.length, 0);
  } finally {
    ladder.restore();
  }
});

test('ответ не содержит полей отправки: метод не отправляет', async () => {
  const ladder = stubLadder({ replies: [readyReply()] });
  try {
    const out = await composeNextMessage(INPUT, ENV);
    for (const field of ['sent_at', 'delivered', 'message_id', 'send_status']) {
      assert.ok(!(field in out.data), `в ответе есть поле ${field}`);
    }
  } finally {
    ladder.restore();
  }
});
