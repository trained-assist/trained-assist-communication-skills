'use strict';

// THE handler: одна реализация генерации и guard'а, две двери (MCP tools и CLI smoke).
// ADR-0001. Всё доменное (выбор шага, ATS, отправка) — у потребителя; здесь только
// нормализация входа, renderer prompt, вызов общей лестницы, проверка формата/ограничений,
// телеметрия без PII.

import { ladderChat, LadderError } from './ladder.mjs';
import { remainingMethodBudget } from './method-budget.mjs';
import { renderWriterPrompt } from './prompt.mjs';
import { extractDialogState, renderDialogState, stateMetrics } from './dialog-state.mjs';
import { TypedError, logEvent } from './typed-error.mjs';

export { TypedError };

export const CONTRACT_VERSION = 'v1';
export const PROMPT_VERSION = 'p1';
export const LADDER_NAME = 'conversation';

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

// ───────────────────────── вход: нормализация и проверки ─────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// crypto.randomUUID is a global in Node >=19 and in workerd; node:crypto is not
// importable in a Worker without the nodejs_compat flag, so the global is the
// one form that runs in BOTH runtimes.
function newRequestId() {
  return globalThis.crypto.randomUUID();
}

function requestIdOf(raw) {
  return typeof raw?.request_id === 'string' && raw.request_id.trim() ? raw.request_id : newRequestId();
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

/**
 * Content words of a text, lowercased, stop-listed and short words removed.
 * Returns a SET (callers only ever test membership and size it).
 *
 * It used to return an Array while callers asked for `.size` — Array has no
 * `size`, so `size < 4` was always false and the repeat guard silently never
 * fired. Both call sites are fixed here rather than at each use.
 */
function contentWords(text, stopSet) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((w) => w.length >= 4 && !stopSet.has(w)),
  );
}

function uncoveredRequiredPoints(input) {
  const points = Array.isArray(input.goal?.required_points) ? input.goal.required_points : [];
  if (!points.length) return [];
  const evidence = supportingEvidence(input);
  return points.filter((p) => {
    const words = [...contentWords(p, POINT_STOP)];
    if (!words.length) return false;
    // Every content word must appear somewhere in the confirmed material. It was
    // `.some` (any one word) before, on a Set — `.some` does not exist on a Set,
    // so this threw-or-silently-passed; `words.some` on a Set is undefined and the
    // check never actually gated anything.
    return !words.every((w) => evidence.includes(w));
  });
}

// ───────────────────────── guard: одна проверка, два входа ─────────────────────────

function priorTexts(input) {
  const history = input.conversation_history;
  if (history.format === 'messages') return history.messages.map((m) => m.text);
  return [history.text];
}

function looksLikeRepeat(input, draft) {
  const draftWords = contentWords(draft, REPEAT_STOP);
  if (draftWords.size < 4) return false;
  for (const prior of priorTexts(input)) {
    const priorWords = contentWords(prior, REPEAT_STOP);
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

/**
 * A draft that re-asks something the dialog already settled. Cheap and
 * deterministic on purpose: we compare CONTENT WORDS of the question against the
 * draft, not embeddings. A false positive costs one retry; a miss ships the
 * exact defect #6 §6 calls out first («Не повторять вопрос, на который уже
 * ответили»). Length-gated so short drafts are never judged on this axis.
 */
/**
 * A draft that re-asks something the dialog already settled.
 *
 * Word overlap alone cannot do this job — it is wrong in both directions. An
 * acknowledgement («вы ответили, что готовы работать удалённо») reuses the
 * question's words while asking nothing, so pure overlap rejects a good draft; a
 * re-ask phrased differently slips through.
 *
 * The signal that actually separates them is the QUESTION MARK. Russian makes
 * written questions explicit, and a draft that both (a) contains a question mark
 * and (b) reuses the majority of a settled question's content words is asking that
 * same question again. Acknowledgements assert and end in a full stop; re-asks ask.
 *
 * Deliberately a heuristic, not a judge: a miss costs one awkward message, a false
 * catch costs a good draft and a retry, so the length gate keeps it off short texts.
 */
/**
 * A draft that re-asks something the dialog already settled.
 *
 * Overlap over the WHOLE draft cannot do this job — it fails in both directions.
 * An acknowledgement («вы ответили, что готовы работать удалённо») reuses the
 * question's words while asking nothing, so whole-draft overlap rejects a good
 * draft; a re-ask phrased differently slips past it.
 *
 * The discriminator is the SENTENCE. Russian makes questions explicit, so we split
 * the draft into sentences and test overlap ONLY inside the ones that actually ask
 * something. The acknowledgement sits in a statement and is ignored; the re-ask
 * sits in a question and is caught — even when the draft also contains an
 * unrelated question elsewhere, which is the common real shape.
 *
 * A heuristic, not a judge: a miss costs one awkward message, a false catch costs
 * a good draft and a retry, so short questions are skipped rather than guessed at.
 */
function repeatsAnsweredQuestion(state, text) {
  // Every SETTLED question counts: answered (do not ask again) and declined (do
  // not ask again either — a refusal is an answer, and re-asking it is the exact
  // defect #6 §6 names). Both are re-asks; they differ only in why.
  const settled = (state?.questions || []).filter((q) => q.status === 'answered' || q.status === 'declined');
  if (!settled.length) return null;

  // Only interrogative sentences can re-ask anything.
  const asking = String(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter((s) => s.includes('?'));
  if (!asking.length) return null;

  for (const q of settled) {
    const qWords = [...contentWords(q.text, POINT_STOP)];
    if (qWords.length < 2) continue;
    for (const sentence of asking) {
      const sentenceWords = contentWords(sentence, REPEAT_STOP);
      if (sentenceWords.size < 5) continue;
      const hit = qWords.filter((w) => sentenceWords.has(w)).length;
      if (hit / qWords.length >= 0.6) {
        const kind = q.status === 'declined' ? 'отказ' : 'ответ';
        return `повторно задан решённый вопрос (${kind} в истории): «${q.text.slice(0, 80)}» → «${String(q.answer_quote || '').slice(0, 60)}»`;
      }
    }
  }
  return null;
}

/**
 * A draft that names a clock time the dialog never confirmed.
 *
 * This is the highest-consequence way a writer can invent a fact: «давайте
 * созвонимся завтра в 11:00» commits the SENDER to a slot that may not exist.
 * Issue #6 §6 puts «без выдуманных условий» in the requirements, and §4 notes
 * that regex is the right tool for «явные даты» — which a clock time is.
 *
 * Only applies when the input supplied NO confirmed availability. If the caller
 * passed slots in `context`, naming one is correct and this check stands down —
 * the method cannot second-guess a fact it was given.
 */
const CLOCK_TIME_RE = /\b\d{1,2}[:.]\d{2}\b|\bв\s+\d{1,2}\s*(?:час|ч\.)/iu;

function inventsTime(input, text) {
  if (!CLOCK_TIME_RE.test(text)) return null;
  // Anything the caller confirmed counts as authorised: context, constraints, or
  // the interlocutor having said it themselves.
  const confirmed = [JSON.stringify(input.context ?? {}), JSON.stringify(input.constraints ?? {}), ...priorTexts(input)].join(' ').toLowerCase();
  const claimed = (text.match(CLOCK_TIME_RE.source ? /\b\d{1,2}[:.]\d{2}\b/gu : []) || [])
    .concat(text.match(/\bв\s+\d{1,2}\s*(?:час|ч\.)/giu) || [])
    .map((s) => s.toLowerCase());
  // Every named time must be traceable to something the input actually said.
  const invented = claimed.filter((t) => !confirmed.includes(t));
  if (!invented.length) return null;
  return `названо неподтверждённое время: «${invented.join('», «')}» — в подтверждённых данных такого нет`;
}

/** Deterministic guard. Вердикт: ok | repeat | low_quality | style_mismatch | constraint_violated. */
export function runGuard({ input, draft, state = null }) {
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
    // Вопросы считаются по знакам вопроса — это честный детерминированный floor.
    // Семантический подсчёт («какая была средняя нагрузка» внутри одного предложения)
    // — задача судьи; на дополнительный вызов лестницы в контракте нет бюджета.
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
  const reAsked = repeatsAnsweredQuestion(state, text);
  if (reAsked) {
    return { verdict: 'constraint_violated', reasons: [reAsked], warnings: [] };
  }
  const invented = inventsTime(input, text);
  if (invented) {
    return { verdict: 'constraint_violated', reasons: [invented], warnings: [] };
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

function noMessageNeeded(reason, requestId, input, metrics, state, t0) {
  // A contact ban is a DECISION, not a missing capability: the ladder is not
  // called, and the caller gets a terminal status it can act on. Spending a
  // writer call here would produce a draft we would then have to suppress —
  // and would be the exact failure mode #6 §6 calls out («Цель не отменяет
  // отказ и запрет контакта»).
  logEvent('generate', { request_id: requestId, status: 'no_message_needed', reason, input_chars: metrics.total_chars });
  return {
    isError: false,
    data: {
      status: 'no_message_needed',
      reason,
      message_text: null,
      warnings: [],
      request_id: requestId,
      context_revision: input.context_revision ?? null,
      generation: { model: null, prompt_version: PROMPT_VERSION, contract_version: CONTRACT_VERSION, attempts: 0 },
      usage: { source: 'none' },
      timing: { total_ms: Date.now() - t0 },
      input_metrics: metrics,
      dialog_state: stateMetrics(state),
    },
  };
}

export async function generateNextMessage(raw, env = {}) {
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

    // Dialog state over the FULL history, built before any topical selection and
    // BEFORE the ladder call — the contact ban is a terminal decision, not a
    // prompt hint (issue #6 §4/§7).
    const state = extractDialogState(input.conversation_history);
    if (state.do_not_contact.detected) {
      return noMessageNeeded(' interlocutor_requested_no_contact', requestId, input, metrics, state, t0);
    }

    const profile = resolveModelProfile(input.model_profile);
    const prompt = renderWriterPrompt(input, state);
    const rejections = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // On a retry the writer is told WHAT the guard rejected. Re-sending the
      // identical prompt produced identical drafts: in live smoke the model
      // invented a call time twice and the budget ran out with no draft at all.
      // The reason is a constraint, not a hint, so it belongs in the retry.
      const messages = attempt === 1
        ? prompt.messages
        : [
          ...prompt.messages.slice(0, -1),
          {
            role: 'user',
            content: `${prompt.messages[prompt.messages.length - 1].content}\n\n`
              + `Предыдущая попытка отклонена проверкой: ${rejections[rejections.length - 1].reasons.join('; ')}. `
              + 'Напиши новый вариант, который это нарушение устраняет. Не выдумывай факты, которых нет в подтверждённых данных.',
          },
        ];

      let call;
      try {
        call = await ladderChat({
          baseUrl: env.LLM_LADDER_URL,
          token: env.LLM_LADDER_TOKEN,
          model: LADDER_NAME,
          messages,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          totalTimeoutMs: remainingMethodBudget(t0, attempt - 1),
        });
      } catch (e) {
        if (e instanceof LadderError) {
          logEvent('generate', { request_id: requestId, code: 'LLM_UNAVAILABLE', attempts: attempt });
          throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${LADDER_NAME} недоступна: ${e.message}`, { attempts: attempt });
        }
        throw e;
      }

      const verdict = runGuard({ input, draft: call.content, state });
      remainingMethodBudget(t0, attempt);
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
            dialog_state: stateMetrics(state),
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

    const verdict = runGuard({ input, draft: raw.draft_message, state: extractDialogState(input.conversation_history) });
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
