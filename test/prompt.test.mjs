'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWriterPrompt } from '../src/prompt.mjs';

function baseInput(overrides = {}) {
  return {
    goal: { instruction: 'Пригласить Анну на созвон' },
    communication_style: { instructions: 'Деловой, тёплый тон' },
    language: 'ru',
    conversation_history: { format: 'messages', messages: [] },
    ...overrides,
  };
}

test('renderWriterPrompt: ровно два сообщения (system + user)', () => {
  const { messages } = renderWriterPrompt(baseInput());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
});

test('goal и язык попадают в промпт', () => {
  const { messages } = renderWriterPrompt(baseInput());
  const user = messages[1].content;
  assert.match(user, /Пригласить Анну на созвон/);
  assert.match(messages[0].content, /языке ru/);
});

test('пустая история помечается явно, а не рисует фиктивный диалог', () => {
  const { messages } = renderWriterPrompt(baseInput());
  assert.match(messages[1].content, /история пуста — это первое сообщение/);
});

test('constraints рендерятся блоком «ключ: значение», массивы через «; »', () => {
  const { messages } = renderWriterPrompt(baseInput({
    constraints: { max_questions: 1, forbidden_claims: ['гарантия трудоустройства', '100%'] },
  }));
  const user = messages[1].content;
  assert.match(user, /max_questions: 1/);
  assert.match(user, /forbidden_claims: гарантия трудоустройства; 100%/);
});

test('неразмеченная история (format=text) показывает speaker_labels, а не угадывает роли', () => {
  const { messages } = renderWriterPrompt(baseInput({
    conversation_history: { format: 'text', text: 'Анна: Здравствуйте', speaker_labels: { sender: 'Ольга', partner: 'Анна' } },
  }));
  const user = messages[1].content;
  assert.match(user, /sender=Ольга/);
  assert.match(user, /partner=Анна/);
  assert.match(user, /Анна: Здравствуйте/);
});

test('сообщения истории подписаны по speaker, имя партнёра подставляется вместо «other»', () => {
  const { messages } = renderWriterPrompt(baseInput({
    conversation_history: {
      format: 'messages',
      messages: [
        { speaker: 'other', speaker_name: 'Анна', text: 'Здравствуйте', timestamp: '2026-10-01' },
        { speaker: 'sender', text: 'Добрый день' },
      ],
    },
  }));
  const user = messages[1].content;
  assert.match(user, /\[Анна\] \(2026-10-01\) Здравствуйте/);
  assert.match(user, /\[sender\] Добрый день/);
});
