'use strict';

// What the classifier actually sees. These assertions are the deterministic half of
// the resolver's quality: the semantic half (did it pick the right option) is measured
// by the labeled corpus, but a dropped negation or a lost option id is a defect in
// THIS renderer and is caught here, offline, every run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIntentPrompt, detectLanguage, attachmentAvailability } from '../src/intent-prompt.mjs';

const CATALOG = [
  {
    id: 'quick_llm_reply',
    description: 'Сформулировать ответ на основе доступного контекста без внешних действий и поиска актуальных данных',
    applicability: 'Объяснения, вопросы о возможностях, обсуждение предоставленных фактов',
  },
  {
    id: 'start_opencode',
    description: 'Запустить OpenCode для выполнения пользовательской задачи',
    applicability: 'Нужны внешние инструменты, поиск актуальных данных, создание артефактов или выполнение действий',
  },
];

function baseInput(overrides = {}) {
  return {
    request_id: 'r-1',
    input_bundle: {
      id: 'b-42',
      version: 'v1',
      events: [
        { id: 'e1', type: 'text', author: 'user', text: 'Посмотри резюме и подбери вакансии. Пока не откликайся.' },
      ],
      attachments: [
        { id: 'a1', name: 'resume.pdf', mime_type: 'application/pdf', resource_ref: 'artifact:resume-42', content_status: 'metadata_only' },
      ],
    },
    recipient: { role: 'Карьерный помощник', persona: 'Помогаю анализировать опыт и искать работу' },
    decision_options: CATALOG,
    ...overrides,
  };
}

test('ровно два сообщения: system + user', () => {
  const { messages } = renderIntentPrompt(baseInput());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
});

test('все id и описания вариантов доходят до классификатора — иначе выбор невозможен', () => {
  const { messages } = renderIntentPrompt(baseInput());
  const user = messages[1].content;
  for (const o of CATALOG) {
    assert.ok(user.includes(`id=${o.id}`), `нет id=${o.id}`);
    assert.ok(user.includes(o.description), `нет описания ${o.id}`);
    assert.ok(user.includes(o.applicability), `нет applicability ${o.id}`);
  }
  assert.ok(user.includes(NO_MATCHING), 'нет зарезервированного значения в списке разрешённых');
});

const NO_MATCHING = 'no_matching_option';

test('текст пользователя передаётся дословно, включая отрицание', () => {
  const { messages } = renderIntentPrompt(baseInput());
  const user = messages[1].content;
  assert.ok(user.includes('Посмотри резюме и подбери вакансии. Пока не откликайся.'));
  assert.ok(user.includes('[e1]'));
});

test('манифест без текста помечен как непрочитанный, а не как прочитанный файл', () => {
  const { messages } = renderIntentPrompt(baseInput());
  const user = messages[1].content;
  assert.ok(user.includes('resume.pdf'));
  assert.ok(user.includes('СОДЕРЖИМОЕ НЕДОСТУПНО'));
  assert.ok(user.includes('Не выдумывай содержимое по имени файла'));
});

test('вложение с переданным текстом считается прочитанным', () => {
  const input = baseInput();
  input.input_bundle.attachments[0] = { ...input.input_bundle.attachments[0], content_status: 'text_available', text: 'Опыт: 5 лет в логистике' };
  const { messages } = renderIntentPrompt(input);
  assert.ok(messages[1].content.includes('Опыт: 5 лет в логистике'));
  assert.ok(!messages[1].content.includes('СОДЕРЖИМОЕ НЕДОСТУПНО'));
});

test('объявленный доступным, но не переданный текст считается непрочитанным', () => {
  const a = { id: 'a1', name: 'resume.pdf', content_status: 'text_available' };
  assert.equal(attachmentAvailability(a).readable, false);
  assert.match(attachmentAvailability(a).why, /не передан/);
});

test('пересланный текст отделён от команды пользователя', () => {
  const { messages } = renderIntentPrompt(baseInput({
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [
        { id: 'e1', type: 'text', author: 'user', text: 'Сократи это', origin: 'user_command' },
        { id: 'e2', type: 'text', author: 'user', text: 'Длинный пересланный текст от коллеги', origin: 'forwarded_content' },
      ],
    },
  }));
  const user = messages[1].content;
  assert.ok(user.includes('команда пользователя'));
  assert.ok(user.includes('данные, а команда только перечислена выше'));
  assert.ok(user.includes('Сократи это'));
  assert.ok(user.includes('Длинный пересланный текст от коллеги'));
});

test('decision_priority передаётся явно, а его отсутствие — тоже', () => {
  const withPriority = renderIntentPrompt(baseInput({ decision_priority: ['start_opencode', 'quick_llm_reply'] }));
  assert.ok(withPriority.messages[1].content.includes('start_opencode > quick_llm_reply'));
  assert.ok(withPriority.messages[1].content.includes('не делает неприменимый подходящим'));

  const without = renderIntentPrompt(baseInput());
  assert.ok(without.messages[1].content.includes('Порядок предпочтения НЕ задан'));
  assert.ok(without.messages[1].content.includes('Порядок массива приоритетом не является'));
});

test('capabilities присутствуют, но не подменяют список решений', () => {
  const { messages } = renderIntentPrompt(baseInput({
    capabilities: [{ id: 'job-search', title: 'Поиск вакансий', description: 'Поиск актуальных вакансий по опыту и условиям', availability: 'enabled' }],
  }));
  const user = messages[1].content;
  assert.ok(user.includes('Поиск вакансий'));
  assert.ok(user.includes('НЕ заменяет список решений'));
});

test('runtime_facts передаются с временем актуальности, их отсутствие — явно', () => {
  const withFacts = renderIntentPrompt(baseInput({
    runtime_facts: [{ key: 'run_status', value: 'завершён', as_of: '2026-10-04T10:00:00+03:00' }],
  }));
  assert.ok(withFacts.messages[1].content.includes('run_status = завершён'));
  assert.ok(withFacts.messages[1].content.includes('актуально на 2026-10-04T10:00:00+03:00'));

  const without = renderIntentPrompt(baseInput());
  assert.ok(without.messages[1].content.includes('(не переданы'));
});

test('missing state facts allow a later check without claiming its result', () => {
  const { messages } = renderIntentPrompt(baseInput({
    input_bundle: { id: 'health-query', events: [{ id: 'e1', type: 'text', author: 'user', text: 'Работает ли помощник?' }] },
    decision_options: [{ id: 'system_health', description: 'Проверить доступность после выбора маршрута' }],
  }));
  assert.ok(messages[0].content.includes('классификация выбирает действие, а не подтверждает его результат'));
  assert.ok(messages[0].content.includes('варианты позволяют только ответить по уже известным данным'));
  assert.ok(messages[1].content.includes('выбрать применимый вариант проверки или получения актуальных данных можно'));
  assert.equal(messages[0].content.includes('основания нет ни у одного варианта'), false);
});

test('активные задачи и прошлый контекст доходят до классификатора', () => {
  const { messages } = renderIntentPrompt(baseInput({
    dialog_context: {
      history: [{ id: 'h1', author: 'user', text: 'Найди вакансии' }, { id: 'h2', author: 'assistant', text: 'Нашла три' }],
      active_tasks: [{ id: 't1', goal: 'Подобрать вакансии по резюме', expected_answer: 'список вакансий' }],
    },
  }));
  const user = messages[1].content;
  assert.ok(user.includes('Найди вакансии'));
  assert.ok(user.includes('Нашла три'));
  assert.ok(user.includes('Подобрать вакансии по резюме'));
  assert.ok(user.includes('ожидаемый ответ: список вакансий'));
});

test('покрытие входа заявлено явно: ничего не отброшено', () => {
  const { messages } = renderIntentPrompt(baseInput());
  const user = messages[1].content;
  assert.match(user, /Покрытие входа: событий 1 из 1, вложений 1 из 1/);
  assert.ok(user.includes('Ничего не отброшено и не обрезано'));
});

test('язык по умолчанию следует за письмом пользователя', () => {
  assert.equal(detectLanguage(baseInput()), 'ru');
  const en = baseInput();
  en.input_bundle.events[0].text = 'Find me some jobs, please';
  assert.equal(detectLanguage(en), 'en');
  assert.equal(detectLanguage(baseInput({ options: { language: 'en' } })), 'en');
});

test('правила называют ловушку «умеешь?» ≠ «найди» и запрет выдумывать варианты', () => {
  const { messages } = renderIntentPrompt(baseInput());
  const system = messages[0].content;
  assert.ok(system.includes('Тематическая близость НЕ равна намерению'));
  assert.ok(system.includes('ты умеешь искать вакансии?'));
  assert.ok(system.includes('Никогда не придумывай свой вариант'));
  assert.ok(system.includes('Отрицания и ограничения — часть цели'));
  assert.ok(system.includes('no_matching_option'));
});
