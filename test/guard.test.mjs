'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuard } from '../src/handler.mjs';

function inputWith(overrides = {}) {
  return {
    goal: { instruction: 'x' },
    communication_style: { instructions: 'x' },
    language: 'ru',
    conversation_history: { format: 'messages', messages: [] },
    ...overrides,
  };
}

test('пустой черновик → low_quality, а не ok', () => {
  const v = runGuard({ input: inputWith(), draft: '   ' });
  assert.equal(v.verdict, 'low_quality');
});

test('дословное повторение реплики собеседника → repeat', () => {
  const input = inputWith({
    conversation_history: {
      format: 'messages',
      messages: [{ speaker: 'partner', text: 'Здравствуйте, мы рассматриваем кандидатов на удалённую вакансию разработчика' }],
    },
  });
  const v = runGuard({ input, draft: 'Здравствуйте, мы рассматриваем кандидатов на удалённую вакансию разработчика' });
  assert.equal(v.verdict, 'repeat');
});

test('черновик не на языке language → style_mismatch', () => {
  const v = runGuard({ input: inputWith({ language: 'ru' }), draft: 'Hello, we would like to invite you for a quick call this week' });
  assert.equal(v.verdict, 'style_mismatch');
});

test('нарушение max_questions (по знакам вопроса) → constraint_violated', () => {
  const input = inputWith({ constraints: { max_questions: 1 } });
  const v = runGuard({ input, draft: 'Какой у вас стек? Какой уровень нагрузки?' });
  assert.equal(v.verdict, 'constraint_violated');
  assert.ok(v.reasons.some((r) => r.includes('max_questions')));
});

test('превышение max_characters → constraint_violated с числами', () => {
  const input = inputWith({ constraints: { max_characters: 10 } });
  const v = runGuard({ input, draft: 'Это сообщение явно длиннее лимита' });
  assert.equal(v.verdict, 'constraint_violated');
  assert.ok(v.reasons.some((r) => r.includes('max_characters')));
});

test('запрещённое утверждение → constraint_violated (регистронезависимо)', () => {
  const input = inputWith({ constraints: { forbidden_claims: ['гарантия трудоустройства'] } });
  const v = runGuard({ input, draft: 'Мы даём ГАРАНТИЯ ТРУДОУСТРОЙСТВА после испытательного срока' });
  assert.equal(v.verdict, 'constraint_violated');
  assert.ok(v.reasons.some((r) => r.includes('запрещённое утверждение')));
});

test('отсутствующий обязательный дословный блок → constraint_violated', () => {
  const input = inputWith({ constraints: { required_verbatim_blocks: ['Вакансия: Senior Backend'] } });
  const v = runGuard({ input, draft: 'Добрый день, расскажу про вакансию разработчика' });
  assert.equal(v.verdict, 'constraint_violated');
  assert.ok(v.reasons.some((r) => r.includes('дословного блока')));
});

test('чистый черновик → ok без причин', () => {
  const v = runGuard({ input: inputWith(), draft: 'Добрый день, Анна! Приглашаю вас на короткий созвон обсудить детали роли.' });
  assert.equal(v.verdict, 'ok');
  assert.deepEqual(v.reasons, []);
});

test('constraint_violated важнее repeat: сначала ограничения, потом повтор', () => {
  const input = inputWith({
    constraints: { max_questions: 0 },
    conversation_history: {
      format: 'messages',
      messages: [{ speaker: 'partner', text: 'Здравствуйте, мы рассматриваем кандидатов на удалённую вакансию разработчика' }],
    },
  });
  const v = runGuard({ input, draft: 'Здравствуйте, мы рассматриваем кандидатов на удалённую вакансию разработчика, верно?' });
  assert.equal(v.verdict, 'constraint_violated');
});
