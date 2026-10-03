'use strict';

// Guard behaviour that is easy to get wrong and was in fact wrong.
//
// The history here: contentWords() returned an Array while its callers asked for
// `.size`, so `size < 4` was ALWAYS false and the repeat guard silently never
// fired — it was green in CI and did nothing. These tests exist so that class of
// bug (a guard that cannot fail) cannot come back unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuard } from '../src/handler.mjs';
import { extractDialogState } from '../src/dialog-state.mjs';

const INPUT = {
  goal: { instruction: 'Предложите созвон' },
  communication_style: { instructions: 'Коротко, уважительно' },
  language: 'ru',
  conversation_history: {
    format: 'messages',
    messages: [
      { id: 'm1', speaker: 'sender', text: 'Готовы ли вы работать удалённо?' },
      { id: 'm2', speaker: 'partner', text: 'Да, только удалённо, офис не рассматриваю.' },
    ],
  },
  constraints: { max_characters: 900, max_questions: 3 },
};

const state = extractDialogState(INPUT.conversation_history);
const check = (draft) => runGuard({ input: INPUT, draft, state }).verdict;

test('ре-asked вопрос: rejection (любой вердикт)', () => {
  // Both `repeat` and `constraint_violated` are correct rejections here; what must
  // not happen is `ok`.
  const v = check('Добрый день, Анна! Подскажите, пожалуйста, готовы ли вы работать удалённо, и рассматриваете ли вы офис?');
  assert.notEqual(v, 'ok');
});

test('подтверждение ответа проходит — переиспользование слов ≠ повторный вопрос', () => {
  // The draft repeats the question's topic words while ASSERTING the answer. It
  // also contains an unrelated question, so a whole-draft overlap check rejects
  // it; only a per-sentence check gets this right.
  assert.equal(
    check('Добрый день, Анна! Вы ответили, что готовы работать удалённо. Посмотрела профиль — вижу опыт в логистике. Работали ли вы с CRM?'),
    'ok',
  );
});

test('переспрашивание отказа отклоняется', () => {
  assert.notEqual(check('Добрый день! Вы готовы работать удалённо. Рассматриваете ли вы офис?'), 'ok');
});

test('чужой вопрос проходит', () => {
  assert.equal(check('Добрый день! Какой у вас опыт работы с SolidWorks и КОМПАС?'), 'ok');
});

test('короткие реплики не осуждаются', () => {
  assert.equal(check('Спасибо! Когда вам удобно созвониться?'), 'ok');
  assert.equal(check('Да?'), 'ok');
});

test('guard действительно ловит дословный повтор (регрессия .size на Array)', () => {
  // The exact defect: contentWords() returned an Array, so draftWords.size was
  // undefined and `undefined < 4` was false → the guard returned false always.
  // Use a verbatim self-introduction: it shares many exact words, which is what
  // this check measures. (Near-paraphrase detection would need stemming, which
  // this guard deliberately does not attempt — see the note below.)
  const input = {
    ...INPUT,
    conversation_history: {
      format: 'messages',
      messages: [{ id: 'p1', speaker: 'partner', text: 'Меня зовут Ольга, я рекрутер компании NexTouch. Работала с системами CRM.' }],
    },
  };
  const draft = 'Добрый день! Меня зовут Ольга, я рекрутер компании NexTouch. Работали с системами CRM?';
  assert.equal(runGuard({ input, draft }).verdict, 'repeat');
});

test('contentWords-типы: guard не падает и не «зелёный вакуумом»', () => {
  // A guard that returns ok for EVERYTHING is the failure mode to defend against.
  const draft = 'Добрый день! Меня зовут Ольга, я рекрутер компании NexTouch. Работали с системами CRM?';
  const input = { ...INPUT, conversation_history: { format: 'messages', messages: [{ id: 'p1', speaker: 'partner', text: 'Меня зовут Ольга, я рекрутер компании NexTouch. Работала с системами CRM.' }] } };
  assert.notEqual(runGuard({ input, draft }).verdict, 'ok');
});

test('известное ограничение: близкий перефраз ловится не всегда', () => {
  // Exact word matching, no stemming/lemmatisation: «логистику» vs «логистикой»
  // are different tokens, so a paraphrase of the partner's own words can pass.
  // Documented rather than hidden — issue #6 §4 allows lexical matching and calls
  // semantic repeat-detection a reranker concern for later, with measurements.
  const input = {
    ...INPUT,
    conversation_history: {
      format: 'messages',
      messages: [{ id: 'p1', speaker: 'partner', text: 'Здравствуйте! Я два года вёл логистику в региональной компании.' }],
    },
  };
  const draft = 'Добрый день! Подскажите, пожалуйста, работали ли вы с логистикой в региональной компании?';
  // Whatever the verdict, it must be a DEFINITE one — the point is that this case
  // is a known miss, not an accident.
  assert.ok(['ok', 'repeat'].includes(runGuard({ input, draft }).verdict));
});
