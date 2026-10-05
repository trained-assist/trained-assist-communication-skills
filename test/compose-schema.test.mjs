'use strict';

// compose_next_message: форма ответа и проверка evidence (issue #28).
//
// Evidence — это единственное, что потребитель не может перепроверить, не
// перечитав диалог: он видит цитату и обязан ей верить. Поэтому проверка
// дословности здесь не «валидация для красоты», а граница доверия.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComposeAnswerSchema,
  validateComposeAnswer,
  validateComposeEvidence,
  buildEvidencePool,
  messageLanguageMatches,
  MAX_KEY_FACTS,
} from '../src/compose-schema.mjs';

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
};

function readyAnswer(overrides = {}) {
  return {
    status: 'ready',
    key_facts: [{ fact: 'Кандидат подтвердил готовность к тестовому', evidence: { quote: 'Да, готов выполнить тестовое задание.', message_id: 'm2' } }],
    next_goal: { instruction: 'Уточнить объём продаж и количество карточек', required_points: [], forbidden_points: [] },
    message: { text: 'Уточните, пожалуйста, объём продаж.', language: 'ru' },
    warnings: [],
    ...overrides,
  };
}

test('корректный ready-ответ проходит валидацию', () => {
  const checked = validateComposeAnswer(readyAnswer());
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.value.status, 'ready');
  assert.equal(checked.value.message.text, 'Уточните, пожалуйста, объём продаж.');
});

test('ready без message или без next_goal отклоняется', () => {
  const noMessage = validateComposeAnswer(readyAnswer({ message: null }));
  assert.equal(noMessage.ok, false);
  assert.ok(noMessage.problems.some((p) => p.includes('message')));

  const noGoal = validateComposeAnswer(readyAnswer({ next_goal: null }));
  assert.equal(noGoal.ok, false);
  assert.ok(noGoal.problems.some((p) => p.includes('next_goal')));
});

test('wait с message отклоняется: не готовое состояние не несёт текст', () => {
  const checked = validateComposeAnswer({
    status: 'wait',
    key_facts: [],
    next_goal: null,
    message: { text: 'Уточните, пожалуйста, объём продаж.', language: 'ru' },
    warnings: ['ждём обещанный ответ'],
  });
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some((p) => p.includes('message')));
});

test('wait без цели и сообщения проходит', () => {
  const checked = validateComposeAnswer({
    status: 'wait',
    key_facts: [],
    next_goal: null,
    message: null,
    warnings: ['ждём обещанный ответ кандидата'],
  });
  assert.equal(checked.ok, true);
});

test('cannot_compose — честный отказ модели, а не ошибка', () => {
  const checked = validateComposeAnswer({
    status: 'cannot_compose',
    key_facts: [],
    next_goal: null,
    message: null,
    warnings: ['недостаточно подтверждённых данных о релокации'],
  });
  assert.equal(checked.ok, true);
});

test('do_not_contact — серверный статус, модель его не возвращает', () => {
  assert.equal(validateComposeAnswer({ status: 'do_not_contact', key_facts: [], next_goal: null, message: null, warnings: [] }).ok, true);
  assert.ok(!buildComposeAnswerSchema().properties.status.enum.includes('do_not_contact'));
});

test('лишние поля и неизвестный status отклоняются', () => {
  const extra = validateComposeAnswer(readyAnswer({ sent_at: '2026-10-05' }));
  assert.equal(extra.ok, false);
  assert.ok(extra.problems.some((p) => p.includes('sent_at')));

  const badStatus = validateComposeAnswer(readyAnswer({ status: 'generated' }));
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.problems.some((p) => p.includes('status')));
});

test('короткая инструкция цели отклоняется', () => {
  const checked = validateComposeAnswer(readyAnswer({
    next_goal: { instruction: 'Спроси', required_points: [], forbidden_points: [] },
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some((p) => p.includes('instruction')));
});

test('key_facts ограничен сверху и не принимает мусор', () => {
  const tooMany = validateComposeAnswer(readyAnswer({
    key_facts: Array.from({ length: MAX_KEY_FACTS + 1 }, (_, i) => ({ fact: `Факт ${i + 1}`, evidence: { quote: 'Москва' } })),
  }));
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.problems.some((p) => p.includes('key_facts')));

  const noEvidence = validateComposeAnswer(readyAnswer({
    key_facts: [{ fact: 'Кандидат подтвердил готовность' }],
  }));
  assert.equal(noEvidence.ok, false);
});

test('evidence: дословная цитата из переданных данных проходит', () => {
  const pool = buildEvidencePool(INPUT);
  const answer = { key_facts: [
    { fact: 'Кандидат подтвердил готовность', evidence: { quote: 'Да, готов выполнить тестовое задание.', message_id: 'm2' } },
    { fact: 'Вакансия в Москве', evidence: { quote: 'Москва' } },
  ] };
  assert.deepEqual(validateComposeEvidence(answer, pool), { ok: true, problems: [] });
});

test('evidence: перефраз не является цитатой', () => {
  const pool = buildEvidencePool(INPUT);
  const answer = { key_facts: [
    { fact: 'Кандидат готов к тестовому', evidence: { quote: 'готов к выполнению тестового', message_id: 'm2' } },
  ] };
  const checked = validateComposeEvidence(answer, pool);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems[0].includes('не дословно совпадает'));
});

test('evidence: цитата не из того сообщения отклоняется', () => {
  const pool = buildEvidencePool(INPUT);
  const answer = { key_facts: [
    { fact: 'Кандидат подтвердил готовность', evidence: { quote: 'Да, готов выполнить тестовое задание.', message_id: 'm1' } },
  ] };
  const checked = validateComposeEvidence(answer, pool);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems[0].includes('m1'));
});

test('evidence: несуществующий message_id отклоняется', () => {
  const pool = buildEvidencePool(INPUT);
  const answer = { key_facts: [
    { fact: 'Кандидат подтвердил готовность', evidence: { quote: 'Да, готов', message_id: 'm99' } },
  ] };
  const checked = validateComposeEvidence(answer, pool);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems[0].includes('m99'));
});

test('evidence: выдуманная цитата не находится в переданных данных', () => {
  const pool = buildEvidencePool(INPUT);
  const answer = { key_facts: [
    { fact: 'Кандидат просил не писать', evidence: { quote: 'больше не пишите мне' } },
  ] };
  const checked = validateComposeEvidence(answer, pool);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems[0].includes('не найдена дословно'));
});

test('evidence: пустая цитата отклоняется', () => {
  const pool = buildEvidencePool(INPUT);
  const checked = validateComposeEvidence({ key_facts: [{ fact: 'Факт', evidence: { quote: '   ' } }] }, pool);
  assert.equal(checked.ok, false);
});

test('evidence: цитата из профиля и контекста тоже доказательство', () => {
  const pool = buildEvidencePool({
    ...INPUT,
    partner_profile: { format: 'text', text: 'Коммерческий опыт в логистике, 4 года.' },
  });
  const checked = validateComposeEvidence({ key_facts: [
    { fact: 'Опыт в логистике', evidence: { quote: 'Коммерческий опыт в логистике, 4 года.' } },
  ] }, pool);
  assert.equal(checked.ok, true);
});

test('message.language обязан совпадать с запрошенным языком', () => {
  assert.equal(messageLanguageMatches({ language: 'ru' }, { text: 'Привет', language: 'ru' }), true);
  assert.equal(messageLanguageMatches({ language: 'ru' }, { text: 'Привет', language: 'ru-RU' }), true);
  assert.equal(messageLanguageMatches({ language: 'ru' }, { text: 'Hi', language: 'en' }), false);
  assert.equal(messageLanguageMatches({ language: 'ru' }, null), true);
});
