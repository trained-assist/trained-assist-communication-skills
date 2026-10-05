'use strict';

// compose_next_message_in_one_call (issue #28) — the one-call alternative to the
// state → goal → message chain.
//
// ONE ladder call returns what the chain returns in three: what happened
// (key_facts), what the next step is (next_goal) and the message text. The point
// of the method is the comparison, not a new default: the chain stays the
// reference, and this handler falls back to it on any technical failure.
//
// What this method deliberately does NOT do:
//  - it does not send anything (no send path exists here at all);
//  - it does not decide to bypass a contact ban — the ban is detected
//    deterministically from the history BEFORE the ladder is called, and the
//    ladder is not called at all;
//  - it does not replace the consumer's freshness / duplicate / contact checks.
//    A `ready` answer is a draft, never permission to send.

import { ladderChat, LadderError } from './ladder.mjs';
import { remainingMethodBudget } from './method-budget.mjs';
import { parseLooseJson } from './intent-schema.mjs';
import {
  validateComposeAnswer,
  validateComposeEvidence,
  buildEvidencePool,
  messageLanguageMatches,
} from './compose-schema.mjs';
import { renderComposePrompt } from './compose-prompt.mjs';
import { extractDialogState, stateMetrics } from './dialog-state.mjs';
import { runGuard, generateNextMessage, CONTRACT_VERSION as WRITER_CONTRACT_VERSION } from './handler.mjs';
import { extractConversationState } from './state-handler.mjs';
import { evaluateNextGoal } from './goal-handler.mjs';
import { TypedError, logEvent } from './typed-error.mjs';

export const COMPOSE_CONTRACT_VERSION = 'v1';
export const COMPOSE_PROMPT_VERSION = 'cp1';
export const COMPOSE_LADDER_NAME = 'conversation';
export const COMPOSE_MAX_ATTEMPTS = 2;
export const COMPOSE_MAX_INPUT_CHARS = 120000;

const MODEL_PROFILES = {
  default: { temperature: 0.7, maxTokens: 1200 },
};

const SPEAKER_ROLES = new Set(['sender', 'partner', 'other']);

// The state schema the internal fallback chain extracts. Fixed on purpose: the
// fallback must run without asking the caller for a schema, and it only feeds
// evaluate_next_goal, which needs the contact ban and the open questions.
// `last_partner_message` is what lets the goal step see what the interlocutor
// actually said rather than only our summary of it.
const FALLBACK_STATE_SCHEMA = {
  type: 'object',
  properties: {
    contact_allowed: { type: 'boolean' },
    do_not_contact: { type: 'boolean' },
    answered_questions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    partner_commitments: { type: 'array', items: { type: 'string' } },
    conditions: { type: 'array', items: { type: 'string' } },
    last_partner_message: { type: 'string' },
  },
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v) {
  return typeof v === 'string' && !!v.trim();
}

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

function requestIdOf(raw) {
  return nonEmpty(raw?.request_id) ? raw.request_id.trim() : newRequestId();
}

function sizeOf(value) {
  if (value === undefined || value === null) return 0;
  return (typeof value === 'string' ? value : JSON.stringify(value)).length;
}

// ───────────────────────── вход ─────────────────────────

export function normalizeComposeInput(raw) {
  if (!isPlainObject(raw)) {
    throw new TypedError('VALIDATION_ERROR', 'аргументы tools/call должны быть объектом', { problems: ['arguments: ожидается объект'] });
  }
  const problems = [];

  if (!nonEmpty(raw.conversation_objective)) problems.push('conversation_objective: требуется непустая строка');

  if (!isPlainObject(raw.communication_style) || !nonEmpty(raw.communication_style.instructions)) {
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

  for (const [key, type] of [['partner_profile', 'object'], ['sender_profile', 'object'], ['context', 'object'], ['constraints', 'object']]) {
    if (raw[key] !== undefined && raw[key] !== null && !isPlainObject(raw[key])) problems.push(`${key}: ожидается объект`);
  }

  // `goal` is NOT part of the compose path — the method formulates it. It is
  // accepted only so the chain fallback has a writer goal to run with; see
  // runChainFallback. Rejecting it here would be wrong, requiring it would be
  // worse: the compose call must stay usable on its own.
  if (raw.goal !== undefined && raw.goal !== null && !isPlainObject(raw.goal)) problems.push('goal: ожидается объект');

  if (raw.fallback !== undefined && raw.fallback !== null && !['chain', 'off'].includes(raw.fallback)) {
    problems.push('fallback: требуется "chain" или "off"');
  }
  if (raw.material_bindings !== undefined) {
    if (!Array.isArray(raw.material_bindings) || raw.material_bindings.length > 100
      || raw.material_bindings.some((b) => !isPlainObject(b) || !nonEmpty(b.stage_id) || Object.keys(b).some((k) => k !== 'stage_id'))
      || new Set(raw.material_bindings.map((b) => b.stage_id)).size !== raw.material_bindings.length) {
      problems.push('material_bindings: требуются объекты с уникальным stage_id (максимум 100)');
    }
  }

  if (problems.length) {
    throw new TypedError('VALIDATION_ERROR', `вход не проходит контракт compose_next_message_in_one_call ${COMPOSE_CONTRACT_VERSION}`, { problems });
  }

  const chars = sizeOf(raw.conversation_objective) + sizeOf(raw.communication_style) + sizeOf(raw.conversation_history)
    + sizeOf(raw.partner_profile) + sizeOf(raw.sender_profile) + sizeOf(raw.context) + sizeOf(raw.constraints);
  if (chars > COMPOSE_MAX_INPUT_CHARS) {
    throw new TypedError(
      'INPUT_TOO_LARGE',
      `вход ${chars} символов > лимита ${COMPOSE_MAX_INPUT_CHARS}: молчаливый slice запрещён`,
      { request_id: raw.request_id ?? null, sizes: { total_chars: chars, limit_chars: COMPOSE_MAX_INPUT_CHARS } },
    );
  }
  return raw;
}

function composeInputMetrics(input) {
  const history = input.conversation_history;
  const historyChars = history.format === 'messages'
    ? history.messages.reduce((sum, m) => sum + (m.text ? m.text.length : 0), 0)
    : history.text.length;
  const chars = (acc, v) => acc + sizeOf(v);
  return {
    history_messages: history.format === 'messages' ? history.messages.length : 1,
    history_chars: historyChars,
    objective_chars: sizeOf(input.conversation_objective),
    style_chars: sizeOf(input.communication_style),
    context_chars: sizeOf(input.context),
    profile_chars: sizeOf(input.partner_profile) + sizeOf(input.sender_profile),
    constraints_chars: sizeOf(input.constraints),
    total_chars: [input.conversation_objective, input.communication_style, input.context, input.partner_profile, input.sender_profile, input.constraints].reduce(chars, 0) + historyChars,
  };
}

function resolveModelProfile(name) {
  if (name === undefined || name === null || name === '') return MODEL_PROFILES.default;
  if (!Object.hasOwn(MODEL_PROFILES, name)) {
    throw new TypedError('MODEL_PROFILE_NOT_ALLOWED', `model_profile=${String(name)} не входит в серверный allowlist [${Object.keys(MODEL_PROFILES).join(', ')}]`, { allowlist: Object.keys(MODEL_PROFILES) });
  }
  return MODEL_PROFILES[name];
}

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
    return { isError: true, data: { error: { code: err.code, message: err.message, ...details }, request_id: rid || requestId } };
  }
  return { isError: true, data: { error: { code: 'INTERNAL', message: 'непредвиденная ошибка compose handler' }, request_id: requestId } };
}

// ───────────────────────── результаты ─────────────────────────

function composeResult({ status, keyFacts, nextGoal, message, warnings, requestId, input, metrics, state, started, model, attempts, usage }) {
  const data = {
    status,
    key_facts: keyFacts,
    next_goal: nextGoal,
    message,
    warnings,
    request_id: requestId,
    context_revision: input.context_revision ?? null,
    generation: { model, prompt_version: COMPOSE_PROMPT_VERSION, contract_version: COMPOSE_CONTRACT_VERSION, attempts },
    usage,
    timing: { total_ms: Date.now() - started },
    input_metrics: metrics,
    dialog_state: stateMetrics(state),
  };
  return {
    isError: false,
    data,
    // Модельные warnings намеренно НЕ едут в _meta: диагностика сериализуется в
    // HTTP-заголовок, а заголовок — это ByteString, и кириллица в свободном тексте
    // модели ломает весь ответ. Потребитель читает warnings из полезной нагрузки.
    meta: {
      request_id: requestId,
      trace_id: input.trace_id ?? requestId,
      conversation_revision: data.context_revision,
      language: input.language,
      generation: data.generation,
      usage,
      timing: data.timing,
      input_metrics: metrics,
    },
  };
}

// ───────────────────────── fallback: существующая цепочка ─────────────────────────

function hasUsableWriterGoal(input) {
  const goal = input.goal;
  return isPlainObject(goal) && nonEmpty(goal.instruction);
}

/**
 * A revision the consumer never supplied, derived from the history content so it
 * changes exactly when the history changes. The chain steps require a non-empty
 * revision (it is their staleness guard), and a random uuid would never change —
 * that would make the check vacuous rather than absent.
 */
function historyRevision(input) {
  const history = input.conversation_history;
  const text = history.format === 'messages'
    ? history.messages.map((m) => `${m.speaker}:${m.text}`).join('\n')
    : history.text;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hist-${hash.toString(16)}`;
}

/**
 * The existing state → goal → message chain, run as the fallback the issue
 * requires: a technical failure of the one-call method must never become an
 * empty or invented message.
 *
 * Returns the writer's result (its shape, its contract version) plus
 * `meta.fallback`, so a consumer can tell a composed draft from a chained one
 * without parsing the payload. Returns null when the chain cannot run at all —
 * which is the case when the caller supplied no writer goal, because the
 * compose path does not need one and the writer does.
 *
 * `reason` is a fixed ASCII code, never raw upstream text: this object is
 * serialised into an HTTP header, and a Cyrillic ladder message there would
 * fail the whole response. The detailed message stays in the typed error.
 */
async function runChainFallback(input, env, { reason, composedAttempts }) {
  if (!hasUsableWriterGoal(input)) return null;
  const requestId = requestIdOf(input);
  const revision = input.context_revision ?? historyRevision(input);
  const traceId = input.trace_id ?? requestId;

  const stateOut = await extractConversationState({
    conversation_history: input.conversation_history,
    state_schema: FALLBACK_STATE_SCHEMA,
    conversation_revision: revision,
    request_id: requestId,
    trace_id: traceId,
  }, env);
  if (stateOut.isError) return null;

  const goalOut = await evaluateNextGoal({
    conversation_objective: input.conversation_objective,
    conversation_state: stateOut.data.state,
    conversation_revision: revision,
    request_id: requestId,
    trace_id: traceId,
  }, env);
  if (goalOut.isError) return null;

  // A terminal goal outcome is a legitimate answer, not a failure: report it in
  // the compose shape so the consumer sees one status either way.
  if (goalOut.data.status !== 'goal_ready') {
    const data = {
      status: goalOut.data.status === 'do_not_contact' ? 'do_not_contact' : 'wait',
      key_facts: [],
      next_goal: null,
      message: null,
      warnings: [goalOut.data.reason || `цепочка остановилась на этапе цели: ${goalOut.data.status}`],
      request_id: requestId,
      context_revision: revision,
      generation: goalOut.data.generation,
      usage: goalOut.data.usage,
      timing: goalOut.data.timing,
      input_metrics: composeInputMetrics(input),
      dialog_state: stateMetrics(extractDialogState(input.conversation_history)),
    };
    return {
      isError: false,
      data,
      meta: { ...(goalOut.meta || {}), fallback: { used: true, reason, composed_attempts: composedAttempts, stopped_at: 'goal' } },
    };
  }
  const writerOut = await generateNextMessage({
    goal: goalOut.data.goal,
    communication_style: input.communication_style,
    language: input.language,
    conversation_history: input.conversation_history,
    ...(input.partner_profile !== undefined ? { partner_profile: input.partner_profile } : {}),
    ...(input.sender_profile !== undefined ? { sender_profile: input.sender_profile } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    context_revision: revision,
    request_id: requestId,
    trace_id: traceId,
    ...(input.model_profile !== undefined ? { model_profile: input.model_profile } : {}),
  }, env);
  if (writerOut.isError) return null;

  // generateNextMessage returns no `meta` of its own (its REST door never sent
  // one), so the chain's observability is rebuilt here from its data: without
  // it a fallback answer would be indistinguishable from a composed one by
  // anything but the payload shape.
  const meta = {
    request_id: requestId,
    trace_id: traceId,
    conversation_revision: revision,
    language: input.language,
    generation: writerOut.data.generation,
    usage: writerOut.data.usage,
    timing: writerOut.data.timing,
    input_metrics: writerOut.data.input_metrics,
    warnings: writerOut.data.warnings,
    fallback: { used: true, reason, composed_attempts: composedAttempts },
  };
  return { ...writerOut, meta };
}

// ───────────────────────── handler ─────────────────────────

/**
 * @param {object} raw tools/call arguments
 * @param {object} env Worker env (LLM_LADDER_URL / LLM_LADDER_TOKEN)
 * @returns {Promise<{isError:boolean, data:object, meta?:object}>}
 */
export async function composeNextMessage(raw, env = {}) {
  const started = Date.now();
  const requestId = requestIdOf(raw);

  let input;
  try {
    input = normalizeComposeInput(raw);
  } catch (e) {
    // Invalid input is NOT a fallback case: the chain would reject the same
    // history too, so running it would only burn budget before failing.
    logEvent('compose', { request_id: requestId, code: e.code || 'INTERNAL' });
    return errorResult(e, requestId);
  }

  const metrics = composeInputMetrics(input);
  const fallbackEnabled = input.fallback !== 'off';

  try {
    resolveModelProfile(input.model_profile);

    // Dialog state over the FULL history, before the ladder call: the contact ban
    // is a terminal decision, not a prompt hint (issue #6 §4/§7, epic #11).
    const state = extractDialogState(input.conversation_history);
    if (state.do_not_contact.detected) {
      logEvent('compose', { request_id: requestId, status: 'do_not_contact', input_chars: metrics.total_chars });
      return composeResult({
        status: 'do_not_contact',
        keyFacts: [],
        nextGoal: null,
        message: null,
        warnings: ['собеседник просил не писать; лестница не вызывалась'],
        requestId, input, metrics, state, started,
        model: null, attempts: 0, usage: { source: 'none' },
      });
    }

    const profile = resolveModelProfile(input.model_profile);
    const { messages } = renderComposePrompt(input);
    const pool = buildEvidencePool(input);
    const rejections = [];

    for (let attempt = 1; attempt <= COMPOSE_MAX_ATTEMPTS; attempt += 1) {
      // On a retry the model is told WHAT was rejected. Re-sending the identical
      // prompt produced identical answers in the writer, and here a single
      // wasted attempt is half the whole budget.
      const callMessages = attempt === 1
        ? messages
        : [
          ...messages.slice(0, -1),
          {
            role: 'user',
            content: `${messages[messages.length - 1].content}\n\n`
              + `Предыдущая попытка отклонена проверкой: ${rejections[rejections.length - 1].join('; ')}. `
              + 'Верни исправленный JSON, которое это нарушение устраняет. Не выдумывай фактов, которых нет в переданных данных.',
          },
        ];

      let res;
      try {
        res = await ladderChat({
          baseUrl: env.LLM_LADDER_URL,
          token: env.LLM_LADDER_TOKEN,
          model: COMPOSE_LADDER_NAME,
          messages: callMessages,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          // response_format ЗДЕСЬ НЕ ОТПРАВЛЯЕТСЯ, и это не упущение.
          // Замер 05.10.2026 на живой лестнице: с json_schema на этой ступени ответ
          // 0/3 содержал key_facts вообще и засыпал поля входа внутрь next_goal;
          // без json_schema — 3/3 корректной формы. Сглаживание evidence
          // (fact+quote на одном уровне, снятие additionalProperties) не помогает:
          // 1/3 и 2/3. Goal-метод с той же json_schema даёт 3/3 — то есть дело не
          // в structured output как таковом, а в том, что эта ступень не умеет
          // выдавать массив объектов внутри схемы.
          // Контракт от этого не слабеет: JSON разбирается и проверяется на
          // сервере, а бюджет на ремонт остаётся прежним.
          app: 'communication-skills-compose',
          traceId: input.trace_id || requestId,
          totalTimeoutMs: remainingMethodBudget(started, attempt - 1),
        });
      } catch (e) {
        if (e instanceof LadderError) {
          logEvent('compose', { request_id: requestId, code: 'LLM_UNAVAILABLE', attempts: attempt });
          if (!fallbackEnabled) {
            throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${COMPOSE_LADDER_NAME} недоступна: ${e.message}`, { attempts: attempt });
          }
          const chain = await runChainFallback(input, env, { reason: 'ladder_unavailable', composedAttempts: attempt });
          if (chain) return chain;
          throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${COMPOSE_LADDER_NAME} недоступна и цепочка не смогла завершиться: ${e.message}`, { attempts: attempt });
        }
        throw e;
      }

      const checked = validateComposeAnswer(parseLooseJson(res.content));
      if (checked.ok) {
        const evidence = validateComposeEvidence(checked.value, pool);
        checked.ok = evidence.ok;
        checked.problems.push(...evidence.problems);
      }
      if (checked.ok && !messageLanguageMatches(input, checked.value.message)) {
        checked.ok = false;
        checked.problems.push(`message.language=${checked.value.message.language} не соответствует запрошенному ${input.language}`);
      }
      // The same deterministic guard the writer applies. A one-call method has
      // no excuse for shipping a draft the chain would have rejected. Only a
      // `ready` answer has a draft to guard — a non-ready one has nothing to send.
      if (checked.ok && checked.value.status === 'ready') {
        const verdict = runGuard({ input, draft: checked.value.message.text, state });
        if (verdict.verdict !== 'ok') {
          checked.ok = false;
          checked.problems.push(...verdict.reasons);
        }
      }

      remainingMethodBudget(started, attempt);
      if (checked.ok) {
        logEvent('compose', { request_id: requestId, status: checked.value.status, attempts: attempt, input_chars: metrics.total_chars, total_ms: Date.now() - started });
        return composeResult({
          status: checked.value.status,
          keyFacts: checked.value.key_facts,
          nextGoal: checked.value.next_goal,
          message: checked.value.message,
          warnings: checked.value.warnings,
          requestId, input, metrics, state, started,
          model: res.model, attempts: attempt, usage: usageFromLadder(res.usage),
        });
      }

      rejections.push(checked.problems);
      logEvent('compose', { request_id: requestId, status: 'guard_rejected', attempt, problems: checked.problems.length });
    }

    if (!fallbackEnabled) {
      throw new TypedError(
        'COMPOSE_REJECTED',
        `ответ compose не прошёл валидацию за ${COMPOSE_MAX_ATTEMPTS} попытки`,
        { attempts: COMPOSE_MAX_ATTEMPTS, rejections },
      );
    }
    const chain = await runChainFallback(input, env, { reason: 'validation_exhausted', composedAttempts: COMPOSE_MAX_ATTEMPTS });
    if (chain) return chain;
    throw new TypedError(
      'COMPOSE_REJECTED',
      `ответ compose не прошёл валидацию и цепочка не смогла завершиться`,
      { attempts: COMPOSE_MAX_ATTEMPTS, rejections },
    );
  } catch (e) {
    // Every fallback decision is made inside the try, where the failure reason is
    // known. This catch is for unexpected errors only: re-running the chain here
    // would mean running it twice for one request.
    logEvent('compose', { request_id: requestId, code: e.code || 'INTERNAL' });
    return errorResult(e, requestId);
  }
}
