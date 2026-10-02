'use strict';

// THE handler: одна реализация генерации и guard'а, две двери (MCP tools и CLI smoke).
// ADR-0001. Всё доменное (выбор шага, ATS, отправка) — у потребителя; здесь только
// нормализация входа, renderer prompt, вызов общей лестницы, проверка формата/ограничений,
// телеметрия без PII.

import { randomUUID } from 'node:crypto';
import { ladderChat, LadderError } from './ladder.mjs';
import { renderWriterPrompt } from './prompt.mjs';

export const CONTRACT_VERSION = 'v1';
export const PROMPT_VERSION = 'p1';
export const LADDER_NAME = 'conversations';

// Общий retry budget: один счётчик на весь путь generate + guard, не перемножается
// между адаптером, MCP и лестницей (review #125, R3).
export const MAX_ATTEMPTS = 2;

export const MAX_INPUT_CHARS = 120000;

// model_profile — только серверный allowlist (R8). Профиль задаёт параметры вызова,
// но НЕ модель: выбор rung остаётся за общей лестницей.
const MODEL_PROFILES = {
  default: { temperature: 0.7, maxTokens: 800 },
};

const SPEAKER_ROLES = new Set(['sender', 'partner', 'other']);

const REPEAT_STOP = new Set([
  'добрый', 'доброе', 'доброго', 'день', 'утро', 'вечер', 'здравствуйте', 'здравствуй',
  'привет', 'спасибо', 'пожалуйста', 'hello', 'thanks', 'thank',
]);

const POINT_STOP = new Set([
  'каждый', 'каждая', 'каждой', 'который', 'которая', 'которое', 'которые', 'которых',
  'также', 'очень', 'этот', 'этого', 'чтобы', 'также', 'назовите', 'назови', 'скажите',
  'расскажите', 'укажите', 'уточните', 'спросите', 'напишите',
]);

export class TypedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TypedError';
    this.code = code;
    this.details = details;
  }
}

// Telemetry: только идентификаторы, статусы и размеры — ни текста диалогов, ни PII (R9).
function logEvent(evt, fields) {
  try { console.error(`[communication] ${JSON.stringify({ evt, ...fields })}`); } catch { /* stderr best-effort */ }
}

// ───────────────────────── вход: нормализация и проверки ─────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function requestIdOf(raw) {
  return typeof raw?.request_id === 'string' && raw.request_id.trim() ? raw.request_id : randomUUID();
}

function normalize(raw, { requireDraft }) {
  if (!isPlainObject(raw)) {
    throw new TypedError('VALIDATION_ERROR', 'аргументы tools/call должны быть объектом', { problems: ['arguments: ожидается объект'] });
  }
  const problems = [];

  if (!isPlainObject(raw.goal) || typeof raw.goal.instruction !== 'string' || !raw.goal.instruction.trim()) {
    problems.push('goal.instruction: требуется непустая строка');
  }
  if (!isPlainObject(raw.communication_style) || typeof raw.communication_style.instructions !== 'string' || !raw.communication_style.instructions.trim()) {
    problems.push('communication_style.instructions: требуется непустая строка');
  }
  if (typeof raw.language !== 'string' || !/^[a-z]{2}(-[A-Za-z0-9]{2,12})?$/i.test(raw.language.trim())) {
    problems.push('language: требуется явный код вида ru или en');
  }

  const history = raw.conversation_history;
  if (!isPlainObject(history) || (history.format !== 'messages' && history.format !== 'text')) {
    problems.push('conversation_history.format: требуется tagged union {format:"messages"|"text"}');
  } else if (history.format === 'messages') {
    if (!Array.isArray(history.messages)) {
      problems.push('conversation_history.messages: требуется массив (пустой = первое сообщение)');
    } else {
      history.messages.forEach((m, i) => {
        if (!isPlainObject(m) || !SPEAKER_ROLES.has(m.speaker)) problems.push(`conversation_history.messages[${i}].speaker: требуется sender|partner|other`);
        if (!isPlainObject(m) || typeof m.text !== 'string' || !m.text.trim()) problems.push(`conversation_history.messages[${i}].text: требуется непустая строка`);
      });
    }
  } else if (typeof history.text !== 'string') {
    problems.push('conversation_history.text: требуется строка');
  }

  if (requireDraft && typeof raw.draft_message !== 'string') {
    problems.push('draft_message: для evaluate_message_quality требуется проверяемое сообщение');
  }
  for (const [key, type] of [['partner_profile', 'object'], ['sender_profile', 'object'], ['context', 'object'], ['constraints', 'object']]) {
    if (raw[key] !== undefined && raw[key] !== null && !isPlainObject(raw[key])) problems.push(`${key}: ожидается объект`);
  }

  if (problems.length) {
    throw new TypedError('VALIDATION_ERROR', `вход не проходит контракт v${CONTRACT_VERSION}`, { problems });
  }
  return raw;
}

function sizeOf(value) {
  if (value === undefined || value === null) return 0;
  return (typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function historyStats(history) {
  if (history.format === 'messages') {
    return { messages: history.messages.length, chars: history.messages.reduce((sum, m) => sum + (m.text ? m.text.length : 0), 0) };
  }
  return { messages: 1, chars: history.text.length };
}

function inputMetrics(input) {
  const h = historyStats(input.conversation_history);
  const goal = sizeOf(input.goal);
  const style = sizeOf(input.communication_style);
  const context = sizeOf(input.context);
  const profile = sizeOf(input.partner_profile) + sizeOf(input.sender_profile);
  const constraints = sizeOf(input.constraints);
  return {
    history_messages: h.messages,
    history_chars: h.chars,
    goal_chars: goal,
    style_chars: style,
    context_chars: context,
    profile_chars: profile,
    constraints_chars: constraints,
    total_chars: goal + style + context + profile + constraints + h.chars,
  };
}

function assertFits(metrics, requestId) {
  if (metrics.total_chars > MAX_INPUT_CHARS) {
    throw new TypedError(
      'INPUT_TOO_LARGE',
      `вход ${metrics.total_chars} символов > лимита ${MAX_INPUT_CHARS}: молчаливый slice запрещён (spec.md)`,
      { request_id: requestId, sizes: { total_chars: metrics.total_chars, limit_chars: MAX_INPUT_CHARS, history_chars: metrics.history_chars } },
    );
  }
}

function resolveModelProfile(name) {
  if (name === undefined || name === null || name === '') return MODEL_PROFILES.default;
  if (!isPlainObject(MODEL_PROFILES) || !Object.hasOwn(MODEL_PROFILES, name)) {
    throw new TypedError('MODEL_PROFILE_NOT_ALLOWED', `model_profile=${String(name)} не входит в серверный allowlist [${Object.keys(MODEL_PROFILES).join(', ')}]`, { allowlist: Object.keys(MODEL_PROFILES) });
  }
  return MODEL_PROFILES[name];
}

function unresolvableLabel(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  if (/^[\s?.*\-–—_]+$/.test(v)) return true;
  return /^(unknown|неизвестно|неизвестен|n\/a|нд)$/i.test(v);
}

function needsContext(missingFields, requestId, input, metrics, extra = {}) {
  logEvent('generate', { request_id: requestId, status: 'needs_context', input_chars: metrics.total_chars });
  return {
    isError: false,
    data: {
      status: 'needs_context',
      warnings: [],
      missing_fields: missingFields,
      request_id: requestId,
      context_revision: input.context_revision ?? null,
      generation: { model: null, prompt_version: PROMPT_VERSION, contract_version: CONTRACT_VERSION, attempts: 0 },
      usage: { source: 'none' },
      timing: { total_ms: extra.total_ms ?? 0 },
      input_metrics: metrics,
    },
  };
}

function ambiguityMissingFields(input) {
  const history = input.conversation_history;
  if (history.format !== 'text') return [];
  const labels = isPlainObject(history.speaker_labels) ? history.speaker_labels : null;
  const senderOk = labels && !unresolvableLabel(labels.sender);
  const partnerOk = labels && !unresolvableLabel(labels.partner);
  const missing = [];
  if (!senderOk || !partnerOk) missing.push('conversation_history.speaker_labels');
  return missing;
}

function supportingEvidence(input) {
  const parts = [
    JSON.stringify(input.context ?? {}),
    JSON.stringify(input.partner_profile ?? {}),
    JSON.stringify(input.conversation_history.format === 'messages'
      ? input.conversation_history.messages.map((m) => m.text)
      : input.conversation_history.text),
  ];
  return parts.join(' ').toLowerCase();
}

function contentWords(text, stopSet) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((w) => w.length >= 4 && !stopSet.has(w));
}

function uncoveredRequiredPoints(input) {
  const points = Array.isArray(input.goal?.required_points) ? input.goal.required_points : [];
  if (!points.length) return [];
  const evidence = supportingEvidence(input);
  return points.filter((p) => {
    const words = contentWords(p, POINT_STOP);
    if (!words.length) return false;
    return !words.some((w) => evidence.includes(w));
  });
}

// ───────────────────────── guard: одна проверка, два входа ─────────────────────────

function priorTexts(input) {
  const history = input.conversation_history;
  if (history.format === 'messages') return history.messages.map((m) => m.text);
  return [history.text];
}

function looksLikeRepeat(input, draft) {
  const draftWords = new Set(contentWords(draft, REPEAT_STOP));
  if (draftWords.size < 4) return false;
  for (const prior of priorTexts(input)) {
    const priorWords = new Set(contentWords(prior, REPEAT_STOP));
    if (!priorWords.size) continue;
    let shared = 0;
    for (const w of draftWords) if (priorWords.has(w)) shared += 1;
    if (shared >= 3 && shared / draftWords.size >= 0.6) return true;
  }
  return false;
}

function languageMismatch(language, draft) {
  const cyr = (draft.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (draft.match(/[a-zA-Z]/g) || []).length;
  const lang = String(language).toLowerCase();
  if (lang.startsWith('ru')) return cyr === 0 && lat > 0;
  if (/^(en|de|fr|es|it|pt|nl|pl|tr)/.test(lang)) return cyr > 0 && cyr >= lat;
  return false;
}

/** Детерминированный guard. Вердикт: ok | repeat | low_quality | style_mismatch | constraint_violated. */
export function runGuard({ input, draft }) {
  const text = typeof draft === 'string' ? draft : '';
  if (!text.trim()) {
    return { verdict: 'low_quality', reasons: ['сообщение пустое'], warnings: [] };
  }

  const c = isPlainObject(input.constraints) ? input.constraints : {};
  const violations = [];
  if (Array.isArray(c.forbidden_claims)) {
    for (const claim of c.forbidden_claims) {
      if (text.toLowerCase().includes(String(claim).toLowerCase())) violations.push(`запрещённое утверждение: «${claim}»`);
    }
  }
  if (Number.isFinite(c.max_characters) && text.length > c.max_characters) {
    violations.push(`длина ${text.length} > max_characters ${c.max_characters}`);
  }
  if (Number.isFinite(c.max_questions)) {
    const questions = (text.match(/\?/g) || []).length;
    if (questions > c.max_questions) violations.push(`вопросов ${questions} > max_questions ${c.max_questions}`);
  }
  if (Array.isArray(c.required_verbatim_blocks)) {
    for (const b of c.required_verbatim_blocks) {
      if (!text.includes(b)) violations.push(`нет обязательного дословного блока: «${String(b).slice(0, 60)}»`);
    }
  }
  if (violations.length) {
    return { verdict: 'constraint_violated', reasons: violations, warnings: [] };
  }
  if (looksLikeRepeat(input, text)) {
    return { verdict: 'repeat', reasons: ['черновик дословно повторяет ранее сказанное в диалоге'], warnings: [] };
  }
  if (languageMismatch(input.language, text)) {
    return { verdict: 'style_mismatch', reasons: [`язык черновика не соответствует language=${input.language}`], warnings: [] };
  }
  return { verdict: 'ok', reasons: [], warnings: [] };
}

// ───────────────────────── двери ─────────────────────────

function usageFromLadder(usage) {
  const out = { source: 'ladder' };
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
    return {
      isError: true,
      data: { error: { code: err.code, message: err.message, ...details }, request_id: rid || requestId },
    };
  }
  return {
    isError: true,
    data: { error: { code: 'INTERNAL', message: 'непредвиденная ошибка handler' }, request_id: requestId },
  };
}

export async function generateNextMessage(raw, env = process.env) {
  const t0 = Date.now();
  const requestId = requestIdOf(raw);
  try {
    const input = normalize(raw, { requireDraft: false });
    const metrics = inputMetrics(input);
    assertFits(metrics, requestId);
    resolveModelProfile(input.model_profile);

    const ambiguous = ambiguityMissingFields(input);
    if (ambiguous.length) {
      return needsContext(ambiguous, requestId, input, metrics, { total_ms: Date.now() - t0 });
    }
    const uncovered = uncoveredRequiredPoints(input);
    if (uncovered.length) {
      return needsContext(uncovered, requestId, input, metrics, { total_ms: Date.now() - t0 });
    }

    const profile = resolveModelProfile(input.model_profile);
    const prompt = renderWriterPrompt(input);
    const rejections = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let call;
      try {
        call = await ladderChat({
          baseUrl: env.LLM_LADDER_URL,
          token: env.LLM_LADDER_TOKEN,
          model: LADDER_NAME,
          messages: prompt.messages,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
        });
      } catch (e) {
        if (e instanceof LadderError) {
          logEvent('generate', { request_id: requestId, code: 'LLM_UNAVAILABLE', attempts: attempt });
          throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${LADDER_NAME} недоступна: ${e.message}`, { attempts: attempt });
        }
        throw e;
      }

      const verdict = runGuard({ input, draft: call.content });
      if (verdict.verdict === 'ok') {
        logEvent('generate', { request_id: requestId, status: 'generated', attempts: attempt, input_chars: metrics.total_chars, total_ms: Date.now() - t0 });
        return {
          isError: false,
          data: {
            status: 'generated',
            message_text: call.content.trim(),
            warnings: verdict.warnings,
            request_id: requestId,
            context_revision: input.context_revision ?? null,
            generation: { model: call.model, prompt_version: PROMPT_VERSION, contract_version: CONTRACT_VERSION, attempts: attempt },
            usage: usageFromLadder(call.usage),
            timing: { total_ms: Date.now() - t0 },
            input_metrics: metrics,
          },
        };
      }
      rejections.push({ attempt, verdict: verdict.verdict, reasons: verdict.reasons });
      logEvent('generate', { request_id: requestId, status: 'guard_rejected', attempt, verdict: verdict.verdict });
    }

    throw new TypedError(
      'GENERATION_REJECTED',
      `guard отклонил черновик на всех ${MAX_ATTEMPTS} попытках (общий retry budget исчерпан)`,
      { attempts: MAX_ATTEMPTS, rejections },
    );
  } catch (e) {
    return errorResult(e, requestId);
  }
}

export function evaluateMessageQuality(raw) {
  const t0 = Date.now();
  const requestId = requestIdOf(raw);
  try {
    const input = normalize(raw, { requireDraft: true });
    const metrics = inputMetrics(input);
    assertFits(metrics, requestId);
    resolveModelProfile(input.model_profile);

    const verdict = runGuard({ input, draft: raw.draft_message });
    logEvent('evaluate', { request_id: requestId, verdict: verdict.verdict, total_ms: Date.now() - t0 });
    return {
      isError: false,
      data: {
        status: 'evaluated',
        verdict: verdict.verdict,
        reasons: verdict.reasons,
        warnings: verdict.warnings,
        request_id: requestId,
        context_revision: input.context_revision ?? null,
        timing: { total_ms: Date.now() - t0 },
        input_metrics: metrics,
      },
    };
  } catch (e) {
    return errorResult(e, requestId);
  }
}
