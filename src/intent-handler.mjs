'use strict';

// THE intent handler: цель пользователя + выбор ровно одного варианта из
// переданного списка. Второй метод того же Worker'а (issue #10), тот же ADR-0001:
// одна прикладная функция на метод, две двери (MCP tools/call и REST).
//
// ГРАНИЦА, КОТОРАЯ ДЕРЖИТ КОНТРАКТ: этот файл НИКОГДА не выходит за пределы
// «сформулировать цель и выбрать id». Он не исполняет решение, не пишет сообщение,
// не запускает агента и не открывает resource_ref. Всё это — у вызывающей стороны
// (issue #10 §1). Поэтому здесь нет ни одного fetch к чему-либо, кроме общей
// лестницы: чужой tenant недостижим by construction, а «VM выключены» не имеет
// отношения к этому методу.
//
// Что здесь НЕ определяется детерминированно и остаётся за классификатором:
// применимы ли два варианта одновременно и, если да, какой выбрать. Это ровно тот
// случай, где угадывание опаснее честного ответа, поэтому приоритет без
// `decision_options`-однозначности уходит в no_matching_option, а качество
// измеряется размеченным корпусом, а не_assert'ом в коде.

import { ladderChat, LadderError } from './ladder.mjs';
import { renderIntentPrompt } from './intent-prompt.mjs';
import { runIntentGuard } from './intent-guard.mjs';
import { compressIntentInput, compressionMetrics, compressionWarnings } from './intent-compress.mjs';
import { buildDecisionOutputSchema, parseLooseJson, NO_MATCHING_OPTION, INTENT_MAX_NAMES_ONLY_OPTIONS } from './intent-schema.mjs';
import { TypedError, logEvent } from './typed-error.mjs';

export const INTENT_CONTRACT_VERSION = 'v1';
export const INTENT_PROMPT_VERSION = 'ip2';

// ЛЕСТНИЦА РЕЗОЛВЕРА — НЕ ЛЕСТНИЦА WRITER'А.
//
// Writer пишет текст пользователю, ему нужен живой ответ и качество формулировки:
// лестница `conversation`. Резолвер не пишет ничего — он выбирает один id из
// закрытого списка и формулирует цель. Это классификация, и лестница под неё уже
// настроена: `service:classify` — free-first (все ранг-и бесплатные), 225 вызовов
// за 24 ч с нулём сбоев. У `conversation` первые два ранг-а платные OpenRouter, и
// там осознанно ловится 402 «Insufficient credits» — то есть 19% отказов на 24 ч.
//
// Решение владельца 17.10.2026: резолверу не нужен `conversation`, ему нужен
// `classify`. Проверено корпусом на живой лестнице — цифры в docs.
//
// `LLM_LADDER_NAME` переопределяет имя для сравнения моделей (issue #10 §7:
// «конкретную модель выбрать сравнением размеченных кейсов»). Прод без флага.
// globalThis, а не process.env: в Cloudflare Worker нет process (nodejs_compat не
// включён), и деплой падал с «process is not defined». В Node globalThis.process
// существует, поэтому локальные замеры переопределением по-прежнему работают.
export const INTENT_LADDER_NAME = globalThis.process?.env?.LLM_LADDER_NAME || 'service:classify';

// Общий retry budget метода: одна попытка + максимум одна ремонтная. Всё.
// Множить его с retry лестницы нельзя — бюджет принадлежит методу (ADR-0001).
export const INTENT_MAX_ATTEMPTS = 2;

export const INTENT_MAX_INPUT_CHARS = 120000;

// Список решений — единственное, что обязано дойти до выбора целиком. Если он не
// помещается, это явная ошибка вызывающей стороны, а не повод тихо выкинуть
// варианты (issue #10 §6.4).
export const INTENT_MAX_DECISION_OPTIONS = 32;
export const INTENT_MAX_OPTIONS_CHARS = 24000;
export { INTENT_MAX_NAMES_ONLY_OPTIONS };

function decisionOptionLimit(options) {
  return options.every(option => isPlainObject(option) && !Object.hasOwn(option, 'description') && !Object.hasOwn(option, 'applicability'))
    ? INTENT_MAX_NAMES_ONLY_OPTIONS : INTENT_MAX_DECISION_OPTIONS;
}

// model_profile — только серверный allowlist, как у writer'а. Параметры вызова
// задают профиль, НЕ модель: rung выбирает общая лестница.
const INTENT_MODEL_PROFILES = {
  // Классификатор: temperature 0 — решение одинаковых входов не должно зависеть
  // от семплирования; 400 токенов хватает на формулировку цели и id.
  default: { temperature: 0, maxTokens: 400 },
};

const CONTENT_STATUSES = new Set(['text_available', 'ocr_available', 'transcript_available', 'metadata_only', 'unavailable']);
const EVENT_ORIGINS = new Set(['user_command', 'forwarded_content', 'document_content']);

// «Decision 3» без описания для выбора не годится (issue #10 §3). Порог —
// Deliberately low: it only rejects a bare label, not a terse description.
const MIN_DESCRIPTION_CHARS = 12;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

function nonEmptyString(v) {
  return typeof v === 'string' && !!v.trim();
}

function sizeOf(value) {
  if (value === undefined || value === null) return 0;
  return (typeof value === 'string' ? value : JSON.stringify(value)).length;
}

// ───────────────────────── вход: нормализация и проверки ─────────────────────────

/**
 * Validate the intent input. Everything rejected here is rejected BEFORE a model
 * call, so a malformed request costs 0 tokens — and, more importantly, a malformed
 * `decision_options` never reaches the classifier as a partial list.
 *
 * @returns {object} normalised input (the same shape, guaranteed well-formed)
 */
export function normalizeIntent(raw) {
  if (!isPlainObject(raw)) {
    throw new TypedError('VALIDATION_ERROR', 'аргументы tools/call должны быть объектом', { problems: ['arguments: ожидается объект'] });
  }
  const problems = [];
  const push = (msg) => problems.push(msg);

  // ── input_bundle ──────────────────────────────────────────────────────────
  const bundle = raw.input_bundle;
  if (!isPlainObject(bundle)) {
    push('input_bundle: требуется объект с id, events и (желательно) attachments');
  } else {
    if (!nonEmptyString(bundle.id)) push('input_bundle.id: требуется непустая строка');
    if (bundle.version !== undefined && !nonEmptyString(bundle.version)) push('input_bundle.version: если задан — непустая строка');
    if (!Array.isArray(bundle.events)) {
      push('input_bundle.events: требуется массив событий (пустой = только вложения)');
    } else {
      const ids = new Set();
      bundle.events.forEach((e, i) => {
        if (!isPlainObject(e)) { push(`input_bundle.events[${i}]: ожидается объект`); return; }
        if (!nonEmptyString(e.id)) push(`input_bundle.events[${i}].id: требуется непустая строка`);
        else if (ids.has(e.id)) push(`input_bundle.events[${i}].id: «${e.id}» повторяется — id событий должны быть уникальны`);
        else ids.add(e.id);
        if (!nonEmptyString(e.type)) push(`input_bundle.events[${i}].type: требуется непустая строка (text|transcript|ocr|note|tool_result)`);
        if (!nonEmptyString(e.author)) push(`input_bundle.events[${i}].author: требуется непустая строка (user|assistant|system|tool)`);
        if (!nonEmptyString(e.text)) push(`input_bundle.events[${i}].text: требуется непустой текст`);
        if (e.origin !== undefined && !EVENT_ORIGINS.has(e.origin)) {
          push(`input_bundle.events[${i}].origin: допустимо ${[...EVENT_ORIGINS].join('|')}`);
        }
      });
    }
    if (bundle.attachments !== undefined && bundle.attachments !== null) {
      if (!Array.isArray(bundle.attachments)) {
        push('input_bundle.attachments: если задан — массив');
      } else {
        const eventIds = new Set((bundle.events || []).map((e) => e?.id));
        bundle.attachments.forEach((a, i) => {
          if (!isPlainObject(a)) { push(`input_bundle.attachments[${i}]: ожидается объект`); return; }
          if (!nonEmptyString(a.id)) push(`input_bundle.attachments[${i}].id: требуется непустая строка`);
          else if (eventIds.has(a.id)) push(`input_bundle.attachments[${i}].id: «${a.id}» совпадает с id события`);
          if (!nonEmptyString(a.name)) push(`input_bundle.attachments[${i}].name: требуется непустая строка`);
          if (!nonEmptyString(a.content_status)) {
            push(`input_bundle.attachments[${i}].content_status: требуется одно из ${[...CONTENT_STATUSES].join('|')} — по нему видно, прочитан файл или нет`);
          } else if (!CONTENT_STATUSES.has(a.content_status)) {
            push(`input_bundle.attachments[${i}].content_status: «${a.content_status}» не входит в ${[...CONTENT_STATUSES].join('|')}`);
          }
          if (a.text !== undefined && !nonEmptyString(a.text)) push(`input_bundle.attachments[${i}].text: если задан — непустая строка`);
        });
      }
    }
    const events = Array.isArray(bundle.events) ? bundle.events : [];
    const attachments = Array.isArray(bundle.attachments) ? bundle.attachments : [];
    if (!events.length && !attachments.length) {
      push('input_bundle: нет ни событий, ни вложений — цель пользователя выводить не из чего');
    }
  }

  // ── recipient ─────────────────────────────────────────────────────────────
  if (!isPlainObject(raw.recipient)) {
    push('recipient: требуется объект с ролью адресата');
  } else if (!nonEmptyString(raw.recipient.role)) {
    push('recipient.role: требуется непустая строка');
  } else {
    for (const k of ['persona', 'scope']) {
      if (raw.recipient[k] !== undefined && !nonEmptyString(raw.recipient[k])) push(`recipient.${k}: если задано — непустая строка`);
    }
  }

  // ── decision_options ──────────────────────────────────────────────────────
  const options = raw.decision_options;
  if (!Array.isArray(options) || !options.length) {
    push('decision_options: требуется НЕПУСТОЙ список — метод не придумывает варианты');
  } else {
    const optionLimit = decisionOptionLimit(options);
    if (options.length > optionLimit) {
      // A dedicated code, not VALIDATION_ERROR: this is not a malformed field, it is
      // a caller asking for a list the method refuses to silently truncate.
      throw new TypedError('TOO_MANY_DECISION_OPTIONS', `вариантов ${options.length} > предела ${optionLimit}; урезать список молча нельзя — расширьте бюджет явно`, { decision_options: options.length, limit: optionLimit });
    }
    const ids = new Set();
    options.forEach((o, i) => {
      if (!isPlainObject(o)) { push(`decision_options[${i}]: ожидается объект {id, description}`); return; }
      if (!nonEmptyString(o.id)) {
        push(`decision_options[${i}].id: требуется непустая строка`);
      } else {
        const id = o.id.trim();
        if (id === NO_MATCHING_OPTION) push(`decision_options[${i}].id: «${NO_MATCHING_OPTION}» зарезервирован сервисом и не может быть пользовательским вариантом`);
        else if (ids.has(id)) push(`decision_options[${i}].id: «${id}» повторяется`);
        else ids.add(id);
      }
      if (!Object.hasOwn(o, 'description')) {
        if (nonEmptyString(o.id) && !/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(o.id.trim())) {
          push(`decision_options[${i}].id: имя метода должно содержать 1–200 символов A–Z, a–z, 0–9, _, ., :, - и начинаться с буквы`);
        }
      } else if (!nonEmptyString(o.description)) {
        push(`decision_options[${i}].description: требуется содержательное описание — по одному названию вариант не выбрать`);
      } else {
        const d = o.description.trim();
        if (d.length < MIN_DESCRIPTION_CHARS) push(`decision_options[${i}].description: ${d.length} симв. < ${MIN_DESCRIPTION_CHARS} — это название, а не описание`);
        if (nonEmptyString(o.id) && d.toLowerCase() === o.id.trim().toLowerCase()) push(`decision_options[${i}].description: повторяет id — описание должно объяснять, что вариант делает`);
      }
      if (o.applicability !== undefined && !nonEmptyString(o.applicability)) push(`decision_options[${i}].applicability: если задано — непустая строка`);
    });
  }

  // ── decision_priority ─────────────────────────────────────────────────────
  if (raw.decision_priority !== undefined && raw.decision_priority !== null) {
    if (!Array.isArray(raw.decision_priority)) {
      push('decision_priority: если задан — массив id вариантов');
    } else if (!raw.decision_priority.length) {
      push('decision_priority: пустой массив равносилен отсутствию приоритета — убери поле или перечисли id');
    } else if (Array.isArray(options)) {
      const known = new Set(options.filter(isPlainObject).map((o) => (nonEmptyString(o.id) ? o.id.trim() : '')).filter(Boolean));
      const seen = new Set();
      raw.decision_priority.forEach((id, i) => {
        if (!nonEmptyString(id)) { push(`decision_priority[${i}]: требуется непустая строка`); return; }
        const v = id.trim();
        if (v === NO_MATCHING_OPTION) push(`decision_priority[${i}]: «${NO_MATCHING_OPTION}» не является вариантом и не может иметь приоритет`);
        else if (!known.has(v)) push(`decision_priority[${i}]: «${v}» нет среди decision_options`);
        else if (seen.has(v)) push(`decision_priority[${i}]: «${v}» повторяется`);
        seen.add(v);
      });
    }
  }

  // ── необязательные блоки ──────────────────────────────────────────────────
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    if (!Array.isArray(raw.capabilities)) push('capabilities: если задан — массив');
    else raw.capabilities.forEach((c, i) => {
      if (!isPlainObject(c)) { push(`capabilities[${i}]: ожидается объект`); return; }
      if (!nonEmptyString(c.id)) push(`capabilities[${i}].id: требуется непустая строка`);
      if (!nonEmptyString(c.title)) push(`capabilities[${i}].title: требуется непустая строка`);
      if (!nonEmptyString(c.description)) push(`capabilities[${i}].description: требуется непустая строка — каталог помогает интерпретировать запрос`);
    });
  }

  if (raw.dialog_context !== undefined && raw.dialog_context !== null) {
    if (!isPlainObject(raw.dialog_context)) {
      push('dialog_context: если задан — объект {history, active_tasks}');
    } else {
      const { history, active_tasks: tasks } = raw.dialog_context;
      if (history !== undefined && history !== null) {
        if (!Array.isArray(history)) push('dialog_context.history: если задана — массив сообщений');
        else history.forEach((h, i) => {
          if (!isPlainObject(h)) { push(`dialog_context.history[${i}]: ожидается объект`); return; }
          if (!nonEmptyString(h.text)) push(`dialog_context.history[${i}].text: требуется непустая строка`);
        });
      }
      if (tasks !== undefined && tasks !== null) {
        if (!Array.isArray(tasks)) push('dialog_context.active_tasks: если заданы — массив');
        else tasks.forEach((t, i) => {
          if (!isPlainObject(t)) { push(`dialog_context.active_tasks[${i}]: ожидается объект`); return; }
          if (!nonEmptyString(t.goal)) push(`dialog_context.active_tasks[${i}].goal: требуется непустая строка`);
        });
      }
    }
  }

  if (raw.runtime_facts !== undefined && raw.runtime_facts !== null) {
    if (!Array.isArray(raw.runtime_facts)) push('runtime_facts: если заданы — массив {key, value, as_of}');
    else raw.runtime_facts.forEach((f, i) => {
      if (!isPlainObject(f)) { push(`runtime_facts[${i}]: ожидается объект`); return; }
      if (!nonEmptyString(f.key)) push(`runtime_facts[${i}].key: требуется непустая строка`);
      if (!nonEmptyString(f.value)) push(`runtime_facts[${i}].value: требуется непустая строка`);
    });
  }

  if (raw.source_refs !== undefined && raw.source_refs !== null) {
    if (!Array.isArray(raw.source_refs)) push('source_refs: если заданы — массив');
    else raw.source_refs.forEach((s, i) => {
      if (!isPlainObject(s) || !nonEmptyString(s.id)) push(`source_refs[${i}].id: требуется непустая строка`);
    });
  }

  if (raw.options !== undefined && raw.options !== null && !isPlainObject(raw.options)) {
    push('options: если задан — объект {language}');
  } else if (isPlainObject(raw.options) && raw.options.language !== undefined) {
    if (typeof raw.options.language !== 'string' || !/^[a-z]{2}(-[A-Za-z0-9]{2,12})?$/i.test(raw.options.language.trim())) {
      push('options.language: требуется явный код вида ru или en');
    }
  }

  if (problems.length) {
    throw new TypedError('VALIDATION_ERROR', `вход не проходит контракт intent ${INTENT_CONTRACT_VERSION}`, { problems });
  }
  return raw;
}

function resolveIntentModelProfile(name) {
  if (name === undefined || name === null || name === '') return INTENT_MODEL_PROFILES.default;
  if (!Object.hasOwn(INTENT_MODEL_PROFILES, name)) {
    throw new TypedError('MODEL_PROFILE_NOT_ALLOWED', `model_profile=${String(name)} не входит в серверный allowlist [${Object.keys(INTENT_MODEL_PROFILES).join(', ')}]`, { allowlist: Object.keys(INTENT_MODEL_PROFILES) });
  }
  return INTENT_MODEL_PROFILES[name];
}

/**
 * Sizes and coverage. `coverage` is a PROMISE, not a report: every event and every
 * attachment reaches the classifier, and the counts say so out loud. A future
 * top-k or a chunker that drops something becomes visible here instead of silently
 * changing answers (issue #10 §6: «неполный проход не выдаётся за полный»).
 */
export function intentInputMetrics(input) {
  const bundle = input.input_bundle;
  const events = bundle.events || [];
  const attachments = bundle.attachments || [];
  const history = input.dialog_context?.history || [];
  const tasks = input.dialog_context?.active_tasks || [];
  const options = input.decision_options || [];
  const caps = input.capabilities || [];
  const facts = input.runtime_facts || [];
  const refs = input.source_refs || [];

  const eventChars = events.reduce((sum, e) => sum + sizeOf(e.text), 0);
  const attachmentChars = attachments.reduce((sum, a) => sum + sizeOf(a.text) + sizeOf(a.name) + sizeOf(a.mime_type) + sizeOf(a.resource_ref), 0);
  const historyChars = history.reduce((sum, h) => sum + sizeOf(h.text), 0);
  const optionsChars = options.reduce((sum, o) => sum + sizeOf(o.id) + sizeOf(o.description) + sizeOf(o.applicability), 0);

  const total = eventChars + attachmentChars + historyChars + optionsChars
    + tasks.reduce((sum, t) => sum + sizeOf(t), 0)
    + caps.reduce((sum, c) => sum + sizeOf(c), 0)
    + facts.reduce((sum, f) => sum + sizeOf(f), 0)
    + refs.reduce((sum, s) => sum + sizeOf(s), 0)
    + sizeOf(input.recipient);

  return {
    events: events.length,
    attachments: attachments.length,
    history_messages: history.length,
    active_tasks: tasks.length,
    capabilities: caps.length,
    decision_options: options.length,
    decision_options_limit: decisionOptionLimit(options),
    runtime_facts: facts.length,
    event_chars: eventChars,
    attachment_chars: attachmentChars,
    history_chars: historyChars,
    options_chars: optionsChars,
    total_chars: total,
    coverage: {
      events_total: events.length,
      events_passed: events.length,
      attachments_total: attachments.length,
      attachments_passed: attachments.length,
      decision_options_total: options.length,
      decision_options_passed: options.length,
      truncated: false,
    },
  };
}

function assertFits(metrics, requestId) {
  if (metrics.total_chars > INTENT_MAX_INPUT_CHARS) {
    throw new TypedError(
      'INPUT_TOO_LARGE',
      `вход ${metrics.total_chars} символов > лимита ${INTENT_MAX_INPUT_CHARS}: молчаливый slice запрещён (issue #10 §6)`,
      { request_id: requestId, sizes: { total_chars: metrics.total_chars, limit_chars: INTENT_MAX_INPUT_CHARS, event_chars: metrics.event_chars, history_chars: metrics.history_chars } },
    );
  }
  if (metrics.decision_options > metrics.decision_options_limit) {
    throw new TypedError('TOO_MANY_DECISION_OPTIONS', `вариантов ${metrics.decision_options} > предела ${metrics.decision_options_limit}`, { decision_options: metrics.decision_options, limit: metrics.decision_options_limit });
  }
  if (metrics.options_chars > INTENT_MAX_OPTIONS_CHARS) {
    throw new TypedError('TOO_MANY_DECISION_OPTIONS', `описания вариантов ${metrics.options_chars} символов > бюджета ${INTENT_MAX_OPTIONS_CHARS}: варианты нельзя выбрасывать молча`, { options_chars: metrics.options_chars, limit_chars: INTENT_MAX_OPTIONS_CHARS });
  }
}

/**
 * Honest warnings about the input itself. The one case worth reporting: the caller
 * declared an attachment's content available but did not send it. The classifier is
 * told to treat it as unread; the caller is told why the answer may be thinner.
 * Counts and ids only — no file content, no PII.
 */
export function collectIntentWarnings(input) {
  const warnings = [];
  for (const a of input.input_bundle?.attachments || []) {
    if (a.content_status === 'text_available' && !a.text?.trim()) {
      warnings.push({ code: 'attachment_text_declared_missing', attachment: a.id, name: a.name || null });
    }
  }
  return warnings;
}

function usageFromLadder(usage) {  const out = { source: 'ladder' };
  if (usage && typeof usage === 'object') {
    if (Number.isFinite(usage.prompt_tokens)) out.input_tokens = usage.prompt_tokens;
    if (Number.isFinite(usage.completion_tokens)) out.output_tokens = usage.completion_tokens;
    if (Number.isFinite(usage.cached_tokens)) out.cached_tokens = usage.cached_tokens;
  }
  return out;
}

function errorResult(err, requestId) {
  if (err instanceof TypedError) {
    const { request_id: rid, ...details } = err.details || {};
    return { isError: true, data: { error: { code: err.code, message: err.message, ...details }, request_id: rid || requestId } };
  }
  return { isError: true, data: { error: { code: 'INTERNAL', message: 'непредвиденная ошибка intent handler' }, request_id: requestId } };
}

function requestIdOf(raw) {
  return nonEmptyString(raw?.request_id) ? raw.request_id.trim() : newRequestId();
}

/**
 * The method.
 *
 * @param {object} raw tool arguments
 * @param {object} env Worker env (LLM_LADDER_URL / LLM_LADDER_TOKEN)
 * @returns {Promise<{isError: boolean, data: object, meta?: object}>} on success
 *   `data` is EXACTLY `{user_goal, decision}`; `meta` carries diagnostics for
 *   `_meta` / HTTP headers and is never part of the two-field answer.
 */
export async function resolveUserIntent(raw, env = {}) {
  const t0 = Date.now();
  const requestId = requestIdOf(raw);
  const traceId = nonEmptyString(raw?.trace_id) ? raw.trace_id.trim() : requestId;

  try {
    const validated = normalizeIntent(raw);

    // Сжатие ДО подсчёта размера и рендера: сжатый вход — это и есть то, что уйдёт
    // модели, и метрики обязаны описывать именно его, иначе «покрытие» и «сколько
    // токенов» будут рассказывать про текст, которого в запросе не было.
    //
    // INTENT_COMPRESS=off — только для замера «полный контекст против сжатия»
    // (issue #10 §9 требует такое сравнение). В проде флаг не выставляется: сжатие
    // включается само, когда событие длиннее порога.
    const { input, reports } = env.INTENT_COMPRESS === 'off'
      ? { input: validated, reports: [] }
      : compressIntentInput(validated);
    const metrics = intentInputMetrics(input);
    metrics.compression = compressionMetrics(reports);
    assertFits(metrics, requestId);
    const profile = resolveIntentModelProfile(input.model_profile);

    const allowedIds = [...input.decision_options.map((o) => o.id.trim()), NO_MATCHING_OPTION];
    const schema = buildDecisionOutputSchema(input.decision_options.map((o) => o.id.trim()));
    const { messages, language } = renderIntentPrompt(input);

    const rejections = [];
    let last = null;

    for (let attempt = 1; attempt <= INTENT_MAX_ATTEMPTS; attempt += 1) {
      // The repair turn states WHAT was wrong. Without it the model repeats the
      // same defect and the second attempt is a paid copy of the first — the exact
      // failure the writer's retry-with-reason was added for (issue #10 §7).
      const call = messages.slice();
      if (attempt > 1) {
        const lastUser = call[call.length - 1];
        call[call.length - 1] = {
          role: 'user',
          content: `${lastUser.content}\n\n`
            + `Предыдущая попытка отклонена проверкой: ${rejections[rejections.length - 1].reasons.join('; ')}. `
            + 'Дай новый ответ строго по схеме: ровно user_goal и decision, decision только из разрешённого списка.',
        };
      }

      let res;
      try {
        res = await ladderChat({
          baseUrl: env.LLM_LADDER_URL,
          token: env.LLM_LADDER_TOKEN,
          model: INTENT_LADDER_NAME,
          messages: call,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          responseFormat: {
            type: 'json_schema',
            json_schema: { name: 'intent_resolution', strict: true, schema },
          },
          app: 'communication-skills-intent',
        });
      } catch (e) {
        if (e instanceof LadderError) {
          logEvent('intent', { request_id: requestId, code: 'LLM_UNAVAILABLE', attempts: attempt });
          throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${INTENT_LADDER_NAME} недоступна: ${e.message}`, { attempts: attempt });
        }
        throw e;
      }

      const parsed = parseLooseJson(res.content);
      const guard = runIntentGuard({ input, output: parsed, allowedIds });
      if (guard.verdict === 'ok') {
        const meta = {
          request_id: requestId,
          trace_id: traceId,
          bundle: { id: input.input_bundle.id, version: input.input_bundle.version ?? null },
          language,
          decision: guard.value.decision,
          reserved: guard.value.decision === NO_MATCHING_OPTION,
          generation: { model: res.model, prompt_version: INTENT_PROMPT_VERSION, contract_version: INTENT_CONTRACT_VERSION, attempts: attempt },
          usage: usageFromLadder(res.usage),
          timing: { total_ms: Date.now() - t0 },
          input_metrics: metrics,
          warnings: collectIntentWarnings(input).concat(compressionWarnings(reports)),
        };
        logEvent('intent', {
          request_id: requestId,
          status: 'resolved',
          decision: guard.value.decision,
          reserved: meta.reserved,
          attempts: attempt,
          options: metrics.decision_options,
          input_chars: metrics.total_chars,
          total_ms: meta.timing.total_ms,
        });
        return { isError: false, data: guard.value, meta };
      }

      rejections.push({ attempt, verdict: guard.verdict, reasons: guard.reasons });
      last = guard;
      logEvent('intent', { request_id: requestId, status: 'guard_rejected', attempt, verdict: guard.verdict });
    }

    throw new TypedError(
      'INTENT_REJECTED',
      `guard отклонил ответ на всех ${INTENT_MAX_ATTEMPTS} попытках (общий retry budget исчерпан)`,
      { attempts: INTENT_MAX_ATTEMPTS, rejections, last_verdict: last?.verdict ?? null },
    );
  } catch (e) {
    return errorResult(e, requestId);
  }
}

export { NO_MATCHING_OPTION };
