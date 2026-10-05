'use strict';

// The two-field contract of `resolve_user_intent` (issue #10 §2).
//
// The point of this file is the FIRST acceptance item: the set of legal `decision`
// values is whatever the caller passed, and swapping the catalog changes the allowed
// ids with ZERO code change. Everything else here is the shape guarantee that makes
// that safe: exactly two fields, no diagnostics leaking into the payload, and a
// provider schema that is re-checked locally rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDecisionOutputSchema,
  buildDecisionResultSchema,
  buildIntentInputSchema,
  validateIntentOutput,
  parseLooseJson,
  NO_MATCHING_OPTION,
  MIN_GOAL_CHARS,
  RESULT_FIELDS,
} from '../src/intent-schema.mjs';

const CATALOG_A = ['quick_llm_reply', 'start_opencode'];
const CATALOG_B = ['answer_from_kb', 'escalate_to_human', 'open_ticket'];

test('enum строится из переданных ids + зарезервированного значения', () => {
  const schema = buildDecisionOutputSchema(CATALOG_A);
  assert.deepEqual(schema.properties.decision.enum, ['quick_llm_reply', 'start_opencode', NO_MATCHING_OPTION]);
  assert.deepEqual(schema.required, [...RESULT_FIELDS]);
  assert.equal(schema.additionalProperties, false);
});

test('замена списка решений меняет разрешённые ids без изменения кода метода', () => {
  const a = buildDecisionOutputSchema(CATALOG_A).properties.decision.enum;
  const b = buildDecisionOutputSchema(CATALOG_B).properties.decision.enum;
  assert.deepEqual(a, ['quick_llm_reply', 'start_opencode', NO_MATCHING_OPTION]);
  assert.deepEqual(b, ['answer_from_kb', 'escalate_to_human', 'open_ticket', NO_MATCHING_OPTION]);
  // Ни один id из чужого каталога не просачивается.
  assert.ok(!b.includes('start_opencode'));
  assert.ok(!a.includes('open_ticket'));
});

test('пустой каталог не даёт схему без зарезервированного значения', () => {
  const schema = buildDecisionOutputSchema([]);
  assert.deepEqual(schema.properties.decision.enum, [NO_MATCHING_OPTION]);
});

test('outputSchema публикует ровно два поля для MCP-клиентов', () => {
  const schema = buildDecisionResultSchema();
  assert.deepEqual(schema.required, ['user_goal', 'decision']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.decision.type, 'string');
  assert.equal(schema.properties.decision.minLength, 1);
  assert.equal(schema.properties.decision.enum, undefined);
  assert.equal(validateIntentOutput({ user_goal: 'Проверить состояние системы', decision: 'system_health' }, ['system_health']).ok, true);
  assert.equal(validateIntentOutput({ user_goal: 'Проверить состояние системы', decision: 'unknown' }, ['system_health']).ok, false);
});

test('inputSchema требует input_bundle, recipient, decision_options', () => {
  const schema = buildIntentInputSchema();
  assert.deepEqual(schema.required, ['input_bundle', 'recipient', 'decision_options']);
  assert.equal(schema.properties.decision_options.minItems, 1);
  assert.deepEqual(schema.properties.decision_options.items.required, ['id', 'description']);
  assert.deepEqual(schema.properties.input_bundle.required, ['id', 'events']);
});

test('валидация принимает ответ из переданного каталога', () => {
  const r = validateIntentOutput(
    { user_goal: 'Подобрать актуальные вакансии по резюме, не отправляя отклики', decision: 'start_opencode' },
    [...CATALOG_A, NO_MATCHING_OPTION],
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.decision, 'start_opencode');
});

test('валидация принимает no_matching_option при любом каталоге', () => {
  const r = validateIntentOutput({ user_goal: 'Остановить текущую задачу', decision: NO_MATCHING_OPTION }, [...CATALOG_B, NO_MATCHING_OPTION]);
  assert.equal(r.ok, true);
});

test('неизвестный id отклоняется — модель не может выбрать не из списка', () => {
  const r = validateIntentOutput({ user_goal: 'Подобрать вакансии', decision: 'stop_task' }, [...CATALOG_A, NO_MATCHING_OPTION]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /stop_task/);
  assert.match(r.problems.join(' '), /не входит в разрешённые/);
});

test('лишние поля отклоняются: в успешном JSON только user_goal и decision', () => {
  const r = validateIntentOutput(
    { user_goal: 'Подобрать вакансии', decision: 'start_opencode', confidence: 0.9, route: 'search' },
    [...CATALOG_A, NO_MATCHING_OPTION],
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /лишние поля/);
  assert.match(r.problems.join(' '), /confidence/);
});

test('отсутствующее поле отклоняется', () => {
  const r = validateIntentOutput({ decision: 'start_opencode' }, [...CATALOG_A, NO_MATCHING_OPTION]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /user_goal/);
});

test('короткий user_goal отклоняется — это не формулировка цели', () => {
  const r = validateIntentOutput({ user_goal: 'вакансии', decision: 'start_opencode' }, [...CATALOG_A, NO_MATCHING_OPTION]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), new RegExp(`короче ${MIN_GOAL_CHARS}`));
});

test('не-JSON и не-объект отклоняются без падения', () => {
  assert.equal(validateIntentOutput(null, [...CATALOG_A, NO_MATCHING_OPTION]).ok, false);
  assert.equal(validateIntentOutput([1, 2], [...CATALOG_A, NO_MATCHING_OPTION]).ok, false);
  assert.equal(validateIntentOutput('строка', [...CATALOG_A, NO_MATCHING_OPTION]).ok, false);
});

test('parseLooseJson снимает ограждение и вытаскивает объект из прозы', () => {
  assert.deepEqual(parseLooseJson('```json\n{"user_goal":"a","decision":"b"}\n```'), { user_goal: 'a', decision: 'b' });
  assert.deepEqual(parseLooseJson('Вот ответ: {"user_goal":"a","decision":"b"} — готово'), { user_goal: 'a', decision: 'b' });
  assert.equal(parseLooseJson('совсем не json'), undefined);
  assert.equal(parseLooseJson(''), undefined);
});
