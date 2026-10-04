'use strict';

// Сжатие длинного ввода: первое + последнее предложение + релевантное из середины.
//
// Главное, что здесь проверяется, — НЕ «стало короче», а «не потерялось
// ограничение». Отрицание в середине длинного текста — самый дорогой дефект этого
// метода: «пока не отправляй», превратившееся в «отправляй», меняет выбранный
// вариант на противоположный. Сжатие не имеет права его съесть.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressEventText,
  compressIntentInput,
  compressionMetrics,
  compressionWarnings,
  splitSentences,
  sentenceReasons,
  INTENT_COMPRESS_OVER_CHARS,
} from '../src/intent-compress.mjs';

// 30 «проходных» предложений-болтовки: они не несут ни команды, ни условия,
// ни факта, ни ссылки на источник — то есть они и есть кандидаты на выброс.
const FILLER = 'Обсуждали это в общем чате несколько раз и в итоге решили пока отложить обсуждение на потом.';

function longText({ middle = [], last = 'И заодно найди вакансии по резюме.' } = {}) {
  return [FILLER, ...Array.from({ length: 30 }, () => FILLER), ...middle, last].join(' ');
}

test('короткий текст не трогается вообще', () => {
  const text = 'Подбери вакансии по резюме. Пока не откликайся.';
  const r = compressEventText(text);
  assert.equal(r.compressed, false);
  assert.equal(r.text, text);
  assert.equal(r.report.sentences_total, 0);
});

test('длинный текст сжимается, и отчёт это показывает', () => {
  const r = compressEventText(longText(), { overChars: 2000 });
  assert.equal(r.compressed, true);
  assert.ok(r.report.chars_after < r.report.chars_before);
  assert.ok(r.report.sentences_dropped > 0, 'ничего не выброшено — сжатие не произошло');
  assert.equal(r.report.sentences_kept + r.report.sentences_dropped, r.report.sentences_total);
});

test('первое и последнее предложение сохраняются ВСЕГДА', () => {
  const r = compressEventText(longText(), { overChars: 2000 });
  const sentences = splitSentences(r.text);
  assert.ok(sentences.length >= 2);
  assert.equal(sentences[0], FILLER, 'первое предложение потеряно');
  assert.match(sentences[sentences.length - 1], /найди вакансии по резюме/, 'последнее предложение потеряно');
});

test('отрицание в середине выживает — это главный инвариант', () => {
  const r = compressEventText(
    longText({ middle: ['Но сначала покажи мне варианты и пока не отправляй отклики.'], last: 'И заодно найди вакансии.' }),
    { overChars: 2000 },
  );
  assert.ok(r.text.includes('пока не отправляй'), 'отрицание потеряно сжатием');
  assert.ok(r.text.includes('сначала'), 'условие «сначала» потеряно');
});

test('команда в середине выживает, даже если не похожа на каталог возможностей', () => {
  // «найди курсы по английскому для уровня B2» не похож ни на одну capability из
  // каталога — ТЗ §6.3 прямо запрещает отбрасывать такое по близости.
  const r = compressEventText(
    longText({ middle: ['Кстати, найди курсы по английскому языку для уровня B2.'], last: 'И посчитай стоимость.' }),
    { overChars: 2000 },
  );
  assert.ok(r.text.includes('курсы по английскому языку'), 'поздняя команда потеряна');
  assert.ok(r.text.includes('B2'));
});

test('вопрос о факте в середине выживает', () => {
  const r = compressEventText(
    longText({ middle: ['Ты умеешь искать вакансии по моему резюме?'], last: 'И найди вакансии.' }),
    { overChars: 2000 },
  );
  assert.ok(r.text.includes('умеешь искать вакансии'));
});

test('факт с числом в середине выживает', () => {
  const r = compressEventText(
    longText({ middle: ['Зарплата от 150 тысяч рублей в месяц.'], last: 'И найди вакансии.' }),
    { overChars: 2000 },
  );
  assert.ok(r.text.includes('150 тысяч'));
});

test('ссылка на источник в середине выживает', () => {
  const r = compressEventText(
    longText({ middle: ['Посмотри приложенный документ и ответь, что там.'], last: 'И найди вакансии.' }),
    { overChars: 2000 },
  );
  assert.ok(r.text.includes('приложенный документ'));
});

test('отрицание НЕ инвертируется: сжатие экстрактивное', () => {
  const before = 'Но сначала покажи мне варианты и пока не отправляй отклики.';
  const r = compressEventText(longText({ middle: [before] }), { overChars: 2000 });
  const kept = splitSentences(r.text).find((s) => s.includes('отклики'));
  assert.equal(kept, before, 'предложение переписано, а не скопировано');
});

test('текст без точек не режется молча', () => {
  const flat = 'а'.repeat(5000);
  const r = compressEventText(flat, { overChars: 2000 });
  assert.equal(r.compressed, false);
  assert.equal(r.report.unsplittable, true);
  assert.equal(r.text, flat, 'текст без предложений нельзя сжать отбором — он уходит как есть');
});

test('бюджет соблюдается, даже если правила оставили слишком много', () => {
  // Каждое предложение содержит цифру → правило «факт» пропускает всё.
  const many = Array.from({ length: 60 }, (_, i) => `Пункт номер ${i} очень важен и обсуждался долго.`);
  const r = compressEventText(many.join(' '), { overChars: 500, targetChars: 400 });
  assert.equal(r.compressed, true);
  assert.ok(r.report.chars_after <= 400, `после сжатия ${r.report.chars_after} символов, бюджет 400`);
});

test('sentenceReasons объясняет, почему предложение сохранено', () => {
  assert.ok(sentenceReasons('Пока не отправляй отклики').includes('negation'));
  assert.ok(sentenceReasons('Найди вакансии по резюме').includes('command'));
  assert.ok(sentenceReasons('Умеешь искать?').includes('question'));
  assert.ok(sentenceReasons('Зарплата 150 тысяч').includes('fact'));
  assert.ok(sentenceReasons('Посмотри приложенный документ').includes('source'));
  assert.deepEqual(sentenceReasons(FILLER), []);
});

test('сжимаются только события пользователя — контекст вызывающей стороны не трогаем', () => {
  const input = {
    input_bundle: {
      id: 'b-1', version: 'v1',
      events: [
        { id: 'e1', type: 'text', author: 'user', text: longText() },
        { id: 'e2', type: 'text', author: 'assistant', text: longText() },
      ],
    },
    recipient: { role: 'Карьерный помощник' },
    decision_options: [{ id: 'x', description: 'Сделать что-то полезное пользователю' }],
  };
  const { input: out, reports, compressed_events } = compressIntentInput(input, { overChars: 2000 });
  assert.equal(compressed_events, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].event_id, 'e1');
  assert.equal(out.input_bundle.events[0].text.length < 5000, true);
  assert.equal(out.input_bundle.events[1].text, input.input_bundle.events[1].text, 'чужой текст изменён');
});

test('исходный input не мутируется', () => {
  const input = {
    input_bundle: { id: 'b-1', version: 'v1', events: [{ id: 'e1', type: 'text', author: 'user', text: longText() }] },
    recipient: { role: 'Карьерный помощник' },
    decision_options: [{ id: 'x', description: 'Сделать что-то полезное пользователю' }],
  };
  const before = input.input_bundle.events[0].text;
  compressIntentInput(input, { overChars: 2000 });
  assert.equal(input.input_bundle.events[0].text, before);
});

test('метрики и warnings содержат только счётчики и id — никакого текста', () => {
  const input = {
    input_bundle: { id: 'b-1', version: 'v1', events: [{ id: 'e1', type: 'text', author: 'user', text: longText({ middle: ['Пока не отправляй отклики и покажи варианты.'] }) }] },
    recipient: { role: 'Карьерный помощник' },
    decision_options: [{ id: 'x', description: 'Сделать что-то полезное пользователю' }],
  };
  const { reports } = compressIntentInput(input, { overChars: 2000 });
  const m = compressionMetrics(reports);
  assert.equal(m.events_compressed, 1);
  assert.ok(m.chars_after < m.chars_before);
  const blob = JSON.stringify(compressionWarnings(reports));
  assert.ok(!blob.includes('отправляй'), 'текст выброшенных предложений попал в диагностику');
  assert.ok(blob.includes('input_compressed'));
});

test('порог по умолчанию — 12000 символов, задокументированная константа', () => {
  assert.equal(INTENT_COMPRESS_OVER_CHARS, 12000);
});
