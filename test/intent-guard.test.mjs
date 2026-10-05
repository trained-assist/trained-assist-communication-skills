'use strict';

// The deterministic guard. Every check here is a decision we can make without
// semantics; the one thing we deliberately do NOT check — whether two options are
// both applicable — is left to the classifier and measured by the corpus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIntentGuard, confirmedEvidence, normalizeGoal, assertsUnreadContent } from '../src/intent-guard.mjs';
import { NO_MATCHING_OPTION } from '../src/intent-schema.mjs';

const ALLOWED = ['quick_llm_reply', 'start_opencode', NO_MATCHING_OPTION];

function input(overrides = {}) {
  return {
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'Подбери вакансии по резюме, пока не откликайся' }],
    },
    recipient: { role: 'Карьерный помощник' },
    decision_options: [
      { id: 'quick_llm_reply', description: 'Сформулировать ответ на основе доступного контекста без внешних действий' },
      { id: 'start_opencode', description: 'Запустить OpenCode для выполнения пользовательской задачи' },
    ],
    ...overrides,
  };
}

test('корректный ответ проходит', () => {
  const g = runIntentGuard({ input: input(), output: { user_goal: 'Подобрать вакансии по резюме, не отправляя отклики', decision: 'start_opencode' }, allowedIds: ALLOWED });
  assert.equal(g.verdict, 'ok');
  assert.equal(g.value.decision, 'start_opencode');
});

test('decision вне списка → shape_invalid', () => {
  const g = runIntentGuard({ input: input(), output: { user_goal: 'Подобрать вакансии по резюме', decision: 'stop_task' }, allowedIds: ALLOWED });
  assert.equal(g.verdict, 'shape_invalid');
  assert.match(g.reasons.join(' '), /stop_task/);
});

test('лишнее поле → shape_invalid', () => {
  const g = runIntentGuard({ input: input(), output: { user_goal: 'Подобрать вакансии', decision: 'start_opencode', confidence: 0.9 }, allowedIds: ALLOWED });
  assert.equal(g.verdict, 'shape_invalid');
  assert.match(g.reasons.join(' '), /confidence/);
});

test('user_goal, дословно повторяющий описание варианта, отклоняется — это не желание пользователя', () => {
  const g = runIntentGuard({
    input: input(),
    output: { user_goal: 'Запустить OpenCode для выполнения пользовательской задачи', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'goal_is_option');
  assert.match(g.reasons.join(' '), /start_opencode/);
});

test('выдуманное время в цели отклоняется, даже если оно правдоподобно', () => {
  const g = runIntentGuard({
    input: input(),
    output: { user_goal: 'Подобрать вакансии и созвониться завтра в 15:30', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'invented_time');
  assert.match(g.reasons.join(' '), /15:30/);
});

test('время, названное самим пользователем, проходит', () => {
  const g = runIntentGuard({
    input: input({ input_bundle: { id: 'b-1', version: 'v1', events: [{ id: 'e1', type: 'text', author: 'user', text: 'Позвони мне завтра в 15:30' }] } }),
    output: { user_goal: 'Позвонить пользователю завтра в 15:30', decision: 'quick_llm_reply' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'ok');
});

test('дата из runtime_facts проходит', () => {
  const g = runIntentGuard({
    input: input({ runtime_facts: [{ key: 'call_slot', value: 'завтра в 15:30', as_of: '2026-10-04T09:00:00+03:00' }] }),
    output: { user_goal: 'Позвонить пользователю завтра в 15:30', decision: 'quick_llm_reply' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'ok');
});

test('утверждение о содержимости непрочитанного файла отклоняется', () => {
  const g = runIntentGuard({
    input: input({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи резюме' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', content_status: 'metadata_only' }],
      },
    }),
    output: { user_goal: 'Перевести резюме: в файле написано, что кандидат 5 лет работал логистом', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'unavailable_source');
  assert.match(g.reasons.join(' '), /в файле/);
});

test('легитимная цель про файл без его содержимого проходит', () => {
  const g = runIntentGuard({
    input: input({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи резюме' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', content_status: 'metadata_only' }],
      },
    }),
    output: { user_goal: 'Перевести приложенный файл резюме на английский язык', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'ok');
});

test('no_matching_option — нормальный ответ, а не ошибка guard\'а', () => {
  const g = runIntentGuard({ input: input(), output: { user_goal: 'Остановить текущую задачу', decision: NO_MATCHING_OPTION }, allowedIds: ALLOWED });
  assert.equal(g.verdict, 'ok');
});

test('цель активной задачи — подтверждённый источник: продолжение не отклоняется как выдумка', () => {
  // Дефект, воспроизведённый на живой форме control plane: active_tasks отрисовываются
  // промптом дословно, но в confirmedEvidence их не было. «Продолжай» после задачи с
  // датой в цели давало INTENT_REJECTED и два оплаченных вызова лестницы.
  const withTask = input({
    dialog_context: { history: [], active_tasks: [{ id: 'ut-1', goal: 'Подготовить отчёт по продажам за 09.2025' }] },
  });
  assert.ok(confirmedEvidence(withTask).includes('09.2025'), 'цель активной задачи не попала в подтверждённые источники');
  const g = runIntentGuard({
    input: withTask,
    output: { user_goal: 'Продолжить подготовку отчёта по продажам за 09.2025', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'ok', g.reasons.join('; '));
});

test('ожидаемый ответ активной задачи тоже подтверждённый источник', () => {
  const withTask = input({ dialog_context: { active_tasks: [{ id: 'ut-1', goal: 'Собрать сводку', expected_answer: 'таблица за 03.2026' }] } });
  assert.ok(confirmedEvidence(withTask).includes('03.2026'));
});

test('утверждение, что содержимое НЕ передано, не считается выдумкой', () => {
  // Промпт прямо требует сказать «прочитать нечего», а вложения от CP приходят всегда
  // без текста. Раньше такая формулировка отклонялась как unavailable_source.
  const honest = [
    ['Ответить, что в документе прочитать нечего: передан только манифест, содержимое не извлечено', 'в документе'],
    ['Ответить, что в файле нет текста: доступен только манифест', 'в файле'],
    ['Сказать, что в приложении нечего разбирать', 'в приложении'],
  ];
  for (const [goal, claim] of honest) {
    assert.equal(assertsUnreadContent(goal, claim), false, `отвергнута честная формулировка: ${goal}`);
  }
});

test('выдумка о содержимом не проходит ни через оговорку, ни через повтор, ни через догадку', () => {
  const cases = [
    ['Ответить, что в документе указано 50 сделок, но прочитать не удалось', 'в документе'],
    ['Ответить, что в документе нечего прочитать, но, вероятно, там релокация', 'в документе'],
    ['Перевести файл: в файле ничего нет, а в файле указано, что опыт 5 лет', 'в файле'],
  ];
  for (const [goal, claim] of cases) {
    assert.equal(assertsUnreadContent(goal, claim), true, `выдумка прошла: ${goal}`);
  }
  // Повторная проверка целиком: guard отклоняет, а не пропускает.
  const g = runIntentGuard({
    input: input({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи резюме' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', content_status: 'metadata_only' }],
      },
    }),
    output: { user_goal: 'Ответить, что в документе указано 50 сделок, но прочитать не удалось', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'unavailable_source');
});

test('прочитанное вложение не считается непрочитанным даже при похожей формулировке', () => {
  const g = runIntentGuard({
    input: input({
      input_bundle: {
        id: 'b-1', version: 'v1',
        events: [{ id: 'e1', type: 'text', author: 'user', text: 'Переведи резюме' }],
        attachments: [{ id: 'a1', name: 'resume.pdf', content_status: 'text_available', text: 'Опыт: 5 лет, логист' }],
      },
    }),
    output: { user_goal: 'Перевести приложенный файл резюме на английский язык', decision: 'start_opencode' },
    allowedIds: ALLOWED,
  });
  assert.equal(g.verdict, 'ok', g.reasons.join('; '));
});

test('confirmedEvidence собирает только подтверждённые источники', () => {
  const ev = confirmedEvidence(input());
  assert.ok(ev.includes('подбери вакансии'));
  assert.ok(ev.includes('запустить opencode'));
  assert.ok(!ev.includes('15:30'));
});

test('normalizeGoal сравнивает формулировки без регистра и пунктуации', () => {
  assert.equal(normalizeGoal('Запустить OpenCode!'), normalizeGoal('запустить  opencode'));
  assert.notEqual(normalizeGoal('Запустить OpenCode'), normalizeGoal('Ответить из базы знаний'));
});
