'use strict';

// Бенчмарк compose против цепочки (issue #28): прогон в тесте нужен не ради цифр,
// а ради двух вещей, которые иначе тихо разъезжаются:
//
//   1. разметка cases.json остаётся самосогласной — статусы двух путей имеют РАЗНЫЕ
//      словари, и если метка забыта, кейс должен стать красным, а не «пропущенным»;
//   2. число вызовов лестницы на кейс — единственная метрика, у которой в офлайне
//      есть содержание, поэтому она проверяется точно, а не «примерно».

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark, renderReport } from '../scripts/benchmark/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(path.join(HERE, '..', 'scripts', 'benchmark', 'cases.json'), 'utf8'));

let cached = null;
const run = async () => (cached ??= await runBenchmark({ mode: 'offline' }));

test('корпус покрывает все десять типов ситуаций из issue #28 плюс контрольные', () => {
  const kinds = new Set(CASES.cases.map((c) => c.kind));
  for (const kind of [
    'first-contact', 'partial-answer', 'test-accepted', 'test-declined',
    'awaiting-submission', 'awaiting-promised-answer', 'call-agreement',
    'correction', 'no-contact', 'insufficient-context', 'fresh-answer',
  ]) {
    assert.ok(kinds.has(kind), `в корпусе нет типа ситуации «${kind}»`);
  }
  assert.ok(CASES.cases.length >= 12, 'кейсов должно быть не меньше 12');
  assert.ok(kinds.has('simple') || CASES.cases.some((c) => c.difficulty === 'simple'));
  assert.ok(CASES.cases.some((c) => c.difficulty === 'ambiguous'), 'нужны неоднозначные кейсы');
});

test('в разметке нет персональных данных и обязательны обе метки статуса', () => {
  const blob = JSON.stringify(CASES);
  for (const forbidden of ['@', 'телефон', 'паспорт']) {
    assert.ok(!blob.includes(forbidden), `в корпусе подозрение на PII: «${forbidden}»`);
  }
  for (const c of CASES.cases) {
    assert.ok(c.expected.compose_status, `${c.id}: нет compose_status`);
    assert.ok(c.expected.chain_status, `${c.id}: нет chain_status`);
    assert.ok(['required', 'absent', 'any'].includes(c.expected.message), `${c.id}: message должен быть required|absent|any`);
    assert.ok(c.expected.ladder_calls?.compose !== undefined, `${c.id}: нет ожидаемого числа вызовов compose`);
    assert.ok(c.expected.ladder_calls?.chain !== undefined, `${c.id}: нет ожидаемого числа вызовов цепочки`);
  }
});

test('запрет контакта: compose не вызывает лестницу вообще, цепочка — один вызов', async () => {
  const { rows } = await run();
  const compose = rows.find((r) => r.id === 'B09' && r.path === 'compose');
  const chain = rows.find((r) => r.id === 'B09' && r.path === 'chain');
  assert.equal(compose.ladderCalls, 0, 'compose обязан решить запрет контакта без модели');
  assert.equal(compose.status, 'do_not_contact');
  assert.equal(compose.messageText, null);
  assert.equal(chain.status, 'do_not_contact');
  assert.ok(chain.ladderCalls >= 1, 'цепочка определяет запрет по извлечённому состоянию, а не детерминированно');
});

test('compose: успешный путь — ровно один вызов лестницы на кейс', async () => {
  const { rows, metrics } = await run();
  const composeRows = rows.filter((r) => r.path === 'compose');
  assert.equal(metrics.overall.compose.ladder_calls_max, 1, 'один вызов на весь метод — иначе это не один вызов');
  assert.ok(composeRows.every((r) => r.problems.length === 0), 'в офлайне все кейсы compose должны быть зелёными');
});

test('обе дороги зелёные на размеченных данных', async () => {
  const { metrics } = await run();
  assert.equal(metrics.overall.compose.failed, 0, `красные кейсы compose: ${metrics.overall.compose.failed}`);
  assert.equal(metrics.overall.chain.failed, 0, `красные кейсы цепочки: ${metrics.overall.chain.failed}`);
  assert.equal(metrics.overall.compose.infra_failures, 0);
});

test('compose делает меньше вызовов лестницы, чем цепочка, на тех же данных', async () => {
  const { metrics } = await run();
  assert.ok(
    metrics.overall.compose.ladder_calls_total < metrics.overall.chain.ladder_calls_total,
    `compose ${metrics.overall.compose.ladder_calls_total} вызовов против цепочки ${metrics.overall.chain.ladder_calls_total}`,
  );
});

test('метрики разнесены по сложности, а не сведены в одно среднее', async () => {
  const { metrics } = await run();
  assert.deepEqual(Object.keys(metrics.by_difficulty).sort(), ['ambiguous', 'simple']);
  for (const group of Object.values(metrics.by_difficulty)) {
    assert.ok(group.compose.cases > 0 && group.chain.cases > 0);
  }
});

test('отчёт честен про то, чего он не измеряет', async () => {
  const { metrics, fixtures } = await run();
  const report = renderReport({ metrics, fixtures });
  assert.ok(report.includes('не измеряют задержку'), 'отчёт обязан говорить, что офлайн не меряет задержку');
  assert.ok(report.includes('константы заглушки'), 'отчёт обязан говорить, что токены в офлайне — константы');
  assert.ok(report.includes('а **не** качество модели'), 'отчёт обязан говорить, что офлайн не меряет модель');
  assert.ok(report.includes('issues/23'), 'в отчёте должна быть ссылка на ревью #23');
  assert.ok(report.includes('issues/11'), 'в отчёте должна быть ссылка на эпик #11');
});