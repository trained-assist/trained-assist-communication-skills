'use strict';

// compose_next_message: промпт одного вызова (issue #28).
//
// Один вызов обязан нести то, что несли три промпта цепочки: цель диалога
// (для шага цели), материал writer'а (для шага сообщения) и правила
// evidence (для шага состояния). Проверяем, что всё это реально доезжает до
// модели, а не просто упомянуто в контракте.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComposePrompt } from '../src/compose-prompt.mjs';

const INPUT = {
  conversation_objective: 'Квалифицировать опыт кандидата с CRM',
  communication_style: { instructions: 'Ты — рекрутер NexTouch. Обращение на «вы», коротко.' },
  language: 'ru',
  conversation_history: {
    format: 'messages',
    messages: [
      { id: 'm1', speaker: 'sender', text: 'Подскажите, с какими CRM вы работали?' },
      { id: 'm2', speaker: 'partner', text: 'Да, готов выполнить тестовое задание.' },
    ],
  },
  partner_profile: { format: 'text', text: 'Коммерческий опыт в логистике, 4 года.' },
  sender_profile: { name: 'Ольга', role: 'рекрутер', organization: 'NexTouch' },
  context: { vacancy: 'Менеджер по продажам, Москва' },
  constraints: { max_characters: 600, max_questions: 1 },
};

test('промпт — это system + один user, и в нём есть цель диалога', () => {
  const { messages, language } = renderComposePrompt(INPUT);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(language, 'ru');
  assert.ok(messages[1].content.includes('Квалифицировать опыт кандидата с CRM'));
});

test('промпт несёт историю, профили, контекст, стиль и ограничения', () => {
  const { messages } = renderComposePrompt(INPUT);
  const user = messages[1].content;
  for (const needle of [
    'Подскажите, с какими CRM вы работали?',
    'Да, готов выполнить тестовое задание.',
    'Коммерческий опыт в логистике, 4 года.',
    'Менеджер по продажам, Москва',
    'Ты — рекрутер NexTouch',
    'max_characters: 600',
    'max_questions: 1',
  ]) {
    assert.ok(user.includes(needle), `в промпте нет «${needle}»`);
  }
});

test('system-часть требует JSON, дословные цитаты и объясняет статусы', () => {
  const { messages } = renderComposePrompt(INPUT);
  const system = messages[0].content;
  for (const needle of ['ready', 'wait', 'cannot_compose', 'ДОСЛОВНАЯ цитата', 'message_id', 'null']) {
    assert.ok(system.includes(needle), `в system-промпте нет «${needle}»`);
  }
});

test('message_id запрещён, если у сообщений истории нет id', () => {
  const { messages } = renderComposePrompt({
    ...INPUT,
    conversation_history: { format: 'messages', messages: [{ speaker: 'partner', text: 'Да, готов' }] },
  });
  const system = messages[0].content;
  assert.ok(system.includes('не используй'));
  assert.ok(!system.includes('id=m1'));
});

test('пустой messages = первое сообщение, а не пустой промпт', () => {
  const { messages } = renderComposePrompt({ ...INPUT, conversation_history: { format: 'messages', messages: [] } });
  assert.ok(messages[1].content.includes('история пуста'));
});

test('text-история без разметки ролей не выдумывает их', () => {
  const { messages } = renderComposePrompt({
    ...INPUT,
    conversation_history: { format: 'text', text: 'С какими CRM работали?', speaker_labels: { sender: 'Рекрутер', partner: 'Кандидат' } },
  });
  const user = messages[1].content;
  assert.ok(user.includes('С какими CRM работали?'));
  assert.ok(user.includes('sender=Рекрутер'));
  assert.ok(user.includes('partner=Кандидат'));
});
