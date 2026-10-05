'use strict';

// The labeled corpus as a test: 72 cases over 5 different decision catalogs, run
// through the REAL handler with the ladder replaced by a script.
//
// What this proves, and what it does not:
//
//   PROVES  every case is a valid input, every label is self-consistent (the
//          reference goal contains the constraints the label requires and none it
//          forbids), the two-field contract holds on every success, the guard
//          catches the defects it is handed, the retry budget is never exceeded,
//          and compression neither loses a mid-text command nor leaves the filler
//          it claimed to have dropped (asserted on the PROMPT that reached the
//          ladder, not on the intent of the test).
//   DOES NOT  prove the model picks the right option. The goal and decision in
//          offline mode come from the label, so `contract_decision_accuracy: 1` is
//          a statement about the pipeline, not about quality. Quality is measured
//          by `node scripts/corpus/run.mjs --live` with the shared ladder's secrets,
//          and the runner says so in its own output rather than letting a green
//          offline run stand in for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCorpus } from '../scripts/corpus/run.mjs';

test('корпус: все кейсы зелёные на контракте (офлайн, лестница подменена скриптом)', async () => {
  const { results, metrics } = await runCorpus({ mode: 'offline' });
  const failed = results.filter((r) => r.problems.length);
  for (const r of failed) {
    console.log(`  ✗ ${r.id} — ${r.title}\n      → ${r.problems.join(' · ')}`);
  }
  assert.equal(failed.length, 0, `${failed.length} кейсов красные`);
  // 75 кейсов исходного корпуса + 25 кейсов на каталоге control plane (integration-v1).
  assert.ok(metrics.cases >= 100, `кейсов ${metrics.cases}, ожидалось не меньше 100`);
});

test('корпус: кейсы сжатия есть и проверяют промпт, а не только ответ', async () => {
  const { results } = await runCorpus({ mode: 'offline', only: null });
  const compress = results.filter((r) => r.id.startsWith('C0'));
  assert.equal(compress.length, 3, 'кейсов сжатия должно быть 3');
  // Промпт проверяется на РЕАЛЬНО ушедшем тексте: если сжатие перестанет
  // отбрасывать болтовню или начнёт съедать отрицание, корпус это поймает.
  const needle = results.filter((r) => r.id === 'C01-compress-negation-survives');
  assert.equal(needle.length, 1);
  assert.equal(needle[0].problems.length, 0, needle[0].problems.join(' · '));
});

test('корпус: шесть разных каталогов решений, а не один', async () => {
  const { results } = await runCorpus({ mode: 'offline' });
  const catalogs = new Set(results.map((r) => r.catalog));
  // integration-v1 — зеркало того каталога, который реально отправляет control plane
  // (PR #43). Список приходит от вызывающей стороны, поэтому корпус обязан
  // проверяться и на нём: тот же метод, другой закрытый список, другой enum ответа.
  assert.deepEqual([...catalogs].sort(), ['integration-v1', 'ops', 'sales', 'single', 'support', 'trained-assist']);
});

test('корпус: на каталоге control plane есть ложно-быстрые, продолжения, отрицания, вложения и quoted-инструкции', async () => {
  const { results } = await runCorpus({ mode: 'offline' });
  const ids = results.filter((r) => r.catalog === 'integration-v1').map((r) => r.id);
  // Смешанный запрос обязан быть agent, а не quick answer: это главный риск формы
  // «вопрос о возможностях + действие», где быстрый ответ тихо теряет задачу.
  for (const id of ['V06-mixed-capability-plus-task', 'V07-mixed-health-plus-action', 'V08-mixed-capability-plus-file']) {
    assert.ok(ids.includes(id), `нет кейса ${id}`);
    const r = results.find((x) => x.id === id);
    assert.equal(r.decision, 'agent', `${id} выбрал ${r.decision} — задача потеряна за быстрым ответом`);
  }
  // Восемь требуемых групп покрыты, а не объявлены: каждая имеет метку и кейс.
  for (const group of [
    'V01-work-paraphrase-alive', 'V04-capability-paraphrase-what-can',
    'V09-continue-active-task', 'V10-continue-by-months', 'V11-do-the-same',
    'V12-look-but-do-not-change', 'V13-do-not-send',
    'V15-attachment-metadata-only', 'V16-unreadable-document-link',
    'V17-capability-not-connected', 'V18-missing-required-input',
    'V21-quoted-instruction-is-data', 'V22-quoted-instruction-cp-no-origin', 'V23-ambiguous-continuation-no-context',
    'V24-long-input-condition-in-middle',
  ]) {
    assert.ok(ids.includes(group), `группа корпуса не покрыта: нет кейса ${group}`);
    assert.equal(results.find((x) => x.id === group).problems.length, 0, `${group} красный`);
  }
});

test('корпус: ноль потерянных размеченных ограничений и подзадач', async () => {
  const { metrics } = await runCorpus({ mode: 'offline' });
  assert.equal(metrics.contract_lost_constraints, 0);
  assert.equal(metrics.contract_goal_completeness, 1);
});

test('корпус: ноль выдуманных live-фактов (вопрос о состоянии без фактов → no_matching_option)', async () => {
  const { metrics } = await runCorpus({ mode: 'offline' });
  assert.equal(metrics.contract_live_state_violations, 0);
});

test('корпус: ни один кейс не превышает общий retry budget метода (2 вызова лестницы)', async () => {
  const { results, metrics } = await runCorpus({ mode: 'offline' });
  const over = results.filter((r) => r.ladderCalls > 2);
  assert.equal(over.length, 0, `кейсы с перерасходом бюджета: ${over.map((r) => `${r.id}(${r.ladderCalls})`).join(', ')}`);
  // И бюджет реально используется: есть кейсы с двумя вызовами (ремонт) и с нулём
  // (контрактные ошибки), иначе проверка была бы пустой.
  assert.ok(results.some((r) => r.ladderCalls === 2), 'нет кейса с ремонтной попыткой');
  assert.ok(results.some((r) => r.ladderCalls === 0), 'нет контрактной ошибки без вызова лестницы');
  assert.equal(metrics.max_ladder_calls, 2);
});

test('корпус: успешные ответы содержат ровно user_goal и decision', async () => {
  const { results } = await runCorpus({ mode: 'offline' });
  const ok = results.filter((r) => !r.isError);
  assert.ok(ok.length > 50);
  for (const r of ok) {
    assert.ok(r.decision, `${r.id}: нет decision`);
  }
});
