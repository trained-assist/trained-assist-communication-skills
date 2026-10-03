'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNextMessage,
  evaluateMessageQuality,
  MAX_INPUT_CHARS,
  MAX_ATTEMPTS,
} from '../src/handler.mjs';

// Все пути ниже детерминированы и не трогают сеть: валидация, размеры,
// needs_context возвращаются ДО вызова лестницы. Путь генерации через
// настоящий MCP tools/call живёт в песочнице (scripts/sandbox/run.sh).

function validInput(overrides = {}) {
  return {
    request_id: 'req-test-1',
    goal: { instruction: 'Пригласить Анну на созвон' },
    communication_style: { instructions: 'Деловой тон' },
    language: 'ru',
    conversation_history: { format: 'messages', messages: [] },
    ...overrides,
  };
}

test('generate: не-объект входа → VALIDATION_ERROR со списком проблем', async () => {
  const r = await generateNextMessage(null, {});
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  assert.ok(r.data.error.problems.length >= 1);
});

test('generate: отсутствует goal.instruction и language → VALIDATION_ERROR перечисляет оба', async () => {
  const r = await generateNextMessage({ communication_style: { instructions: 'x' }, conversation_history: { format: 'messages', messages: [] } }, {});
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'VALIDATION_ERROR');
  const problems = r.data.error.problems.join(' | ');
  assert.match(problems, /goal\.instruction/);
  assert.match(problems, /language/);
});

test('generate: кривой speaker в истории → VALIDATION_ERROR с индексом сообщения', async () => {
  const r = await generateNextMessage(validInput({
    conversation_history: { format: 'messages', messages: [{ speaker: 'boss', text: 'x' }] },
  }), {});
  assert.equal(r.isError, true);
  assert.match(r.data.error.problems.join(' '), /messages\[0\]\.speaker/);
});

test('generate: вход больше лимита → INPUT_TOO_LARGE c размерами, без молчаливого обрезания', async () => {
  const r = await generateNextMessage(validInput({
    context: { blob: 'x'.repeat(MAX_INPUT_CHARS + 1) },
  }), {});
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'INPUT_TOO_LARGE');
  assert.equal(r.data.error.sizes.limit_chars, MAX_INPUT_CHARS);
  assert.ok(r.data.error.sizes.total_chars > MAX_INPUT_CHARS);
});

test('generate: model_profile вне allowlist → MODEL_PROFILE_NOT_ALLOWED', async () => {
  const r = await generateNextMessage(validInput({ model_profile: 'turbo' }), {});
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'MODEL_PROFILE_NOT_ALLOWED');
  assert.deepEqual(r.data.error.allowlist, ['default']);
});

test('generate: текстовая история без speaker_labels → needs_context, лестница не вызывается', async () => {
  const r = await generateNextMessage(validInput({
    conversation_history: { format: 'text', text: 'Анна: Здравствуйте' },
  }), {});
  assert.equal(r.isError, false);
  assert.equal(r.data.status, 'needs_context');
  assert.ok(r.data.missing_fields.includes('conversation_history.speaker_labels'));
  assert.equal(r.data.generation.attempts, 0);
});

test('generate: неразрешимая метка роли (? / неизвестно) → needs_context', async () => {
  const r = await generateNextMessage(validInput({
    conversation_history: { format: 'text', text: 'Здравствуйте', speaker_labels: { sender: 'неизвестно', partner: '?' } },
  }), {});
  assert.equal(r.data.status, 'needs_context');
  assert.ok(r.data.missing_fields.includes('conversation_history.speaker_labels'));
});

test('generate: обязательный пункт не подтверждён фактами → needs_context с этим пунктом', async () => {
  const r = await generateNextMessage(validInput({
    goal: { instruction: 'x', required_points: ['зарплата двести тысяч рублей'] },
  }), {});
  assert.equal(r.data.status, 'needs_context');
  assert.ok(r.data.missing_fields.includes('зарплата двести тысяч рублей'));
});

test('evaluate: без draft_message → VALIDATION_ERROR (контракт требует проверяемое сообщение)', () => {
  const r = evaluateMessageQuality(validInput());
  assert.equal(r.isError, true);
  assert.match(r.data.error.problems.join(' '), /draft_message/);
});

test('evaluate: чистый черновик → verdict=ok, статус evaluated', () => {
  const r = evaluateMessageQuality(validInput({
    draft_message: 'Добрый день, Анна! Приглашаю на короткий созвон обсудить роль.',
  }));
  assert.equal(r.isError, false);
  assert.equal(r.data.status, 'evaluated');
  assert.equal(r.data.verdict, 'ok');
});

test('evaluate: нарушение constraints → verdict=constraint_violated с причинами', () => {
  const r = evaluateMessageQuality(validInput({
    constraints: { max_questions: 1 },
    draft_message: 'Какой стек? Какой уровень нагрузки?',
  }));
  assert.equal(r.data.verdict, 'constraint_violated');
  assert.ok(r.data.reasons.length >= 1);
});

test('evaluate: общий retry budget зафиксирован — MAX_ATTEMPTS=2 на весь путь', () => {
  assert.equal(MAX_ATTEMPTS, 2);
});
