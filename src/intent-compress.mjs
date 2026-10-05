'use strict';

// Сжатие длинного пользовательского ввода — детерминированное, экстрактивное,
// без вызова модели (issue #10 §6.3).
//
// ПОЧЕМУ ЭКСТРАКТИВНОЕ. Единственное, что здесь недопустимо, — инверсия
// отрицания: «пока не отправляй» → «отправляй». Переписывание текста моделью —
// это ровно тот риск, поэтому предложения ОТБИРАЮТСЯ, а не пересказываются.
// Отбор не может изменить смысл предложения, только взять или не взять его.
//
// ПОЧЕМУ НЕ «РЕЛЕВАНТНОЕ К CAPABILITIES». ТЗ §6.3 прямо запрещает отбрасывать
// блок из-за низкой близости к возможностям, и это правильно: «найди курсы по
// английскому» не похож на каталог, но это команда. Релевантность здесь
// СИНТАКСИЧЕСКАЯ и правиловая — предложение сохраняется, если несёт команду,
// отрицание, условие, факт или упоминание источника. Никакого similarity, никаких
// embeddings: они в том же ТЗ отложены (R45), и по той же причине.
//
// ЧТО НИКОГДА НЕ ТЕРЯЕТСЯ. Первое и последнее предложение сохраняются всегда:
// первое задаёт рамку («пересылаю переписку…»), последнее обычно несёт собственно
// команду (кейс I10 «поздняя команда в длинном тексте»). Правила покрывают
// середину; всё, что не прошло, честно попадает в отчёт.
//
// Молчаливого сжатия нет: результат возвращается вместе с отчётом, вызывающая
// сторона видит, сколько предложений выброшено. Если вход не влезает даже после
// сжатия — это явная ошибка, а не тихое усечение.

/** Порог, выше которого событие сжимается: 12000 символов ≈ 4800 токенов русского. */
export const INTENT_COMPRESS_OVER_CHARS = 12000;

/**
 * Целевой бюджет одного сжатого события. Четверть порога: типичная болтовня
 * сжимается вчетверо, а команды, отрицания и факты о собеседнике выживают
 * независимо от бюджета — они режутся последними (см. DROP_RANK).
 */
export const INTENT_COMPRESS_TARGET_CHARS = 2000;

// Отрицание и условие. Самое дорогое, что можно потерять: потерянное «пока не
// отправляй» превращает выбор варианта в противоположный.
//
// «Потом» и «затем» сюда НЕ входят, хотя формально это последовательность:
// «обсудим это на потом» и «потом посмотрю» встречаются в каждом втором сообщении
// и не несут ограничения, а правило, которое держит половину болтовни, не
// сжимает ничего. Последовательность вроде «сначала покажи, потом отправь» ловится
// «сначала» и командой во втором предложении.
const NEGATION_RE = /(?<![\p{L}\p{N}])(?:не|ни|нет|никто|ничего|без|кроме|помимо|запрещ(?:ено|ается)|нельзя|не\s+нужно|не\s+надо|не\s+стоит|не\s+следует|пока\s+не|сначала|только\s+(?:лишь|же)|если\s+не)(?![\p{L}\p{N}])/iu;

// Команда: глагол во 2-м лице (ты/вы) или инфинитив в начале предложения. Закрытый
// список — не словарь русского языка, а те глаголы, которыми формулируют задачу
// в этом домене; добавлять сюда новые глаголы без нужды не стоит (ложное срабатывание
// стоит лишних токенов, пропуск команды — неверного выбора).
const IMPERATIVE_RE = /(?<![\p{L}\p{N}])(?:найди|подбери|переведи|сделай|ответь|покажи|напиши|отправь|отправьте|сформируй|запусти|проверь|разберись|расскажи|объясни|помоги|нужно|надо|давай|дай|заведи|открой|закрой|удали|измени|добавь|убери|исправь|повтори|прочитай|посмотри|изучи|сравни|замени|собери|выгрузи|загрузи|подключи|включи|выключи|настрой|разверни|откати|перезапусти|увеличь|уменьш|сними|поставь|восстанови|подготовь|сравни)(?![\p{L}\p{N}])/iu;

// Вопрос о возможностях («умеешь…?», «можно…?») — задача, которую нельзя выбросить.
const QUESTION_RE = /\?/u;

// Факт, который нельзя выдумать заново: число, дата, время, деньги.
const FACT_RE = /\d|\b(?:сегодня|завтра|вчера|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|руб|доллар|евро)\b/iu;

// Источник: файл, документ, картинка, лог — то, про что спрашивают.
const SOURCE_RE = /(?<![\p{L}\p{N}])(?:файл|файла|документ|документа|резюме|вложение|вложения|приложенн\w*|картинк\w*|скриншот\w*|изображен\w*|лог|логи|transcript|ocr|pdf|docx|csv|xlsx|json|txt)(?![\p{L}\p{N}])/iu;

const RULES = [
  ['negation', NEGATION_RE],
  ['command', IMPERATIVE_RE],
  ['question', QUESTION_RE],
  ['source', SOURCE_RE],
  ['fact', FACT_RE],
];

// Что можно резать первым, когда не влезает в бюджет.
//
// Ранг тем меньше, тем жалюбей резать. Порядок выбран по цене ошибки, а не по
// «интересности»: потерянное «пока не отправляй» меняет ВЫБРАННЫЙ ВАРИАНТ на
// противоположный, потерянный «пункт 64 из списка» не меняет ничего. Первая версия
// резала по расстоянию до края и первым выкидывала предпоследнее предложение —
// то есть ровно то, где обычно стоит отрицание. Это был не тест, а находка.
//
//   fact(5) → question(4) → source(3) → command(2) → negation(1) → края не режемся
const DROP_RANK = {
  fact: 5,
  question: 4,
  source: 3,
  command: 2,
  negation: 1,
  first_or_last: 0,
};

function dropScore(index, total, why) {
  const rank = Math.max(...why.map((r) => DROP_RANK[r] ?? 3));
  // Внутри одного ранга сначала режется середина: начало и конец задают рамку.
  const distance = Math.min(index, total - 1 - index);
  return rank * 1000 + distance;
}

/**
 * Split into sentences. Deliberately the same rule the writer's guard uses
 * (`(?<=[.!?…])\s+|\n+`): one convention in the repo means one behaviour.
 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Why a sentence was kept — for the report, so a reviewer can see the reason. */
export function sentenceReasons(sentence) {
  const out = [];
  for (const [name, re] of RULES) {
    if (re.test(sentence)) out.push(name);
  }
  return out;
}

/**
 * Compress one event text.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.overChars] порог, выше которого сжимаем
 * @param {number} [opts.targetChars] сколько символов оставить
 * @returns {{text: string, compressed: boolean, report: object}}
 */
export function compressEventText(text, { overChars = INTENT_COMPRESS_OVER_CHARS, targetChars = INTENT_COMPRESS_TARGET_CHARS } = {}) {
  const original = String(text ?? '');
  const base = {
    chars_before: original.length,
    chars_after: original.length,
    sentences_total: 0,
    sentences_kept: 0,
    sentences_dropped: 0,
    dropped_by_rules: 0,
    dropped_by_budget: 0,
    kept: [],
    dropped: [],
    reasons: {},
    threshold_chars: overChars,
  };
  if (original.length <= overChars) {
    return { text: original, compressed: false, report: base };
  }

  const sentences = splitSentences(original);
  base.sentences_total = sentences.length;
  if (sentences.length <= 2) {
    // Два предложения — это «первое + последнее», сжимать нечего. Обрезать надо
    // явно и с отчётом, а не молча: значит, текст верхом без точек.
    return { text: original, compressed: false, report: { ...base, unsplittable: true } };
  }

  // Всегда первое и последнее: рамка и команда.
  const keep = new Set([0, sentences.length - 1]);
  const reasons = new Map();
  for (const idx of [0, sentences.length - 1]) reasons.set(idx, ['first_or_last']);

  // Промежуточная таблица «прошло правило / не прошло» — из неё потом считаются
  // ОБЕ потери. Считать только бюджетные потери было бы враньём в отчёте:
  // предложения, отброшенные правилами, никуда не попадали.
  const droppedByRules = [];
  for (let i = 1; i < sentences.length - 1; i += 1) {
    const why = sentenceReasons(sentences[i]);
    if (why.length) {
      keep.add(i);
      reasons.set(i, why);
    } else {
      droppedByRules.push(i);
    }
  }

  // Бюджет. Жертвы выбираются по dropScore, а не по близости к краю: сначала
  // уходит «факт» (число в середине болтовни), и только если не влезло —
  // команда, и лишь в последнюю очередь отрицание.
  let keptChars = [...keep].reduce((sum, i) => sum + sentences[i].length, 0);
  const droppedByBudget = [];
  if (keptChars > targetChars) {
    const candidates = [...keep]
      .filter((i) => i !== 0 && i !== sentences.length - 1)
      .map((i) => ({ i, score: dropScore(i, sentences.length, reasons.get(i) || []) }))
      .sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (keptChars <= targetChars) break;
      droppedByBudget.push(c.i);
      keep.delete(c.i);
      reasons.delete(c.i);
      keptChars -= sentences[c.i].length;
    }
  }

  const kept = [...keep].sort((a, b) => a - b);
  const out = kept.map((i) => sentences[i]).join(' ');
  for (const i of kept) for (const r of (reasons.get(i) || [])) base.reasons[r] = (base.reasons[r] || 0) + 1;
  base.kept = kept;
  base.dropped = [...droppedByRules, ...droppedByBudget].sort((a, b) => a - b);
  base.dropped_by_rules = droppedByRules.length;
  base.dropped_by_budget = droppedByBudget.length;
  base.sentences_kept = kept.length;
  base.sentences_dropped = base.dropped.length;
  base.chars_after = out.length;

  return { text: out, compressed: true, report: base };
}

/**
 * Compress a normalised intent input's event texts IN PLACE-FREE fashion: returns
 * a shallow copy with compressed `event.text` and a report per event id.
 *
 * Only `author === 'user'` events are compressed: everything else in the package is
 * the caller's context, and the caller's own words are what decides the answer.
 * Attachments are never touched — a manifest is not compressible text.
 *
 * @returns {{input: object, reports: Array<object>, compressed_events: number}}
 */
export function compressIntentInput(input, opts = {}) {
  const events = input.input_bundle?.events || [];
  const reports = [];
  let changed = 0;

  const nextEvents = events.map((e) => {
    if (!e || typeof e.text !== 'string') return e;
    if (e.author !== 'user') return e;
    const { text, compressed, report } = compressEventText(e.text, opts);
    if (!compressed) {
      // «Не сжалось» и «сжимать было нечего» — разные вещи, а отчёт обязан их
      // различать. Событие длиннее порога, которое splitSentences не смогло
      // разрезать (простыня без точек и переводов строк), уходит к классификатору
      // ЦЕЛИКОМ: восемьдесят тысяч символов вместо двух, при maxTokens 400 на
      // ответ. Раньше это выглядело как «вход уместился» — events_compressed: 0 и
      // ни одного warning, то есть метрика врала в обе стороны. Теперь такая
      // попытка попадает в отчёт и в warning: метод не обрезает молча, и вызывающая
      // сторона видит, что ей надо разбить пакет у себя.
      if (report.unsplittable) {
        changed += 1;
        reports.push({ event_id: e.id, ...report });
      }
      return e;
    }
    changed += 1;
    reports.push({ event_id: e.id, ...report });
    return { ...e, text };
  });

  if (!changed) return { input, reports, compressed_events: 0 };
  return {
    input: { ...input, input_bundle: { ...input.input_bundle, events: nextEvents } },
    reports,
    compressed_events: changed,
  };
}

/** Diagnostics without any user text: ids and counts only (no PII in logs). */
export function compressionMetrics(reports) {
  return {
    events_compressed: reports.length,
    chars_before: reports.reduce((s, r) => s + r.chars_before, 0),
    chars_after: reports.reduce((s, r) => s + r.chars_after, 0),
    sentences_total: reports.reduce((s, r) => s + r.sentences_total, 0),
    sentences_kept: reports.reduce((s, r) => s + r.sentences_kept, 0),
    sentences_dropped: reports.reduce((s, r) => s + r.sentences_dropped, 0),
    dropped_by_rules: reports.reduce((s, r) => s + (r.dropped_by_rules || 0), 0),
    dropped_by_budget: reports.reduce((s, r) => s + (r.dropped_by_budget || 0), 0),
  };
}

/**
 * Сжатие рапортуется как warning, а не как молчаливый факт: вызывающая сторона
 * должна видеть, что часть предложений не дошла до классификатора. Только
 * счётчики и id события — текст выброшенных предложений в диагностику не попадает.
 */
export function compressionWarnings(reports) {
  return reports
    .filter((r) => r.sentences_dropped > 0 || r.unsplittable)
    .map((r) => ({
      // Два разных события, поэтому два разных кода: `input_compressed` — часть
      // предложений не дошла до классификатора, `input_uncompressible` — не дошла
      // вся граница события, и метод не имел права её резать.
      code: r.unsplittable ? 'input_uncompressible' : 'input_compressed',
      event: r.event_id,
      sentences_total: r.sentences_total,
      sentences_kept: r.sentences_kept,
      sentences_dropped: r.sentences_dropped,
      chars_before: r.chars_before,
      chars_after: r.chars_after,
    }));
}
