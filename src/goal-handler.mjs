'use strict';

import { ladderChat, LadderError } from './ladder.mjs';
import { remainingMethodBudget } from './method-budget.mjs';
import { parseLooseJson } from './intent-schema.mjs';
import { buildGoalDecisionSchema, validateGoalDecision } from './goal-schema.mjs';
import { renderGoalPrompt } from './goal-prompt.mjs';
import { TypedError, logEvent } from './typed-error.mjs';

export const GOAL_CONTRACT_VERSION = 'v1';
export const GOAL_PROMPT_VERSION = 'gp5';
export const GOAL_LADDER_NAME = globalThis.process?.env?.LLM_LADDER_NAME || 'service:classify';
export const GOAL_MAX_ATTEMPTS = 2;
export const GOAL_MAX_INPUT_CHARS = 120000;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === 'string' && !!v.trim(); }
function requestIdOf(raw) { return nonEmpty(raw?.request_id) ? raw.request_id.trim() : globalThis.crypto.randomUUID(); }
function hasContactBan(state) {
  return state?.contact_allowed === false || state?.do_not_contact === true || state?.do_not_contact?.detected === true;
}

export function normalizeGoalInput(raw) {
  if (!isObject(raw)) throw new TypedError('VALIDATION_ERROR', 'arguments must be an object', { problems: ['arguments: expected object'] });
  const problems = [];
  if (!nonEmpty(raw.conversation_objective)) problems.push('conversation_objective: required non-empty high-level objective');
  if (!isObject(raw.conversation_state)) problems.push('conversation_state: expected object');
  if (!nonEmpty(raw.conversation_revision)) problems.push('conversation_revision: required non-empty revision for stale-result protection');
  if (raw.language !== undefined && !nonEmpty(raw.language)) problems.push('language: expected non-empty string when present');
  if (raw.model_profile !== undefined && raw.model_profile !== 'default') throw new TypedError('MODEL_PROFILE_NOT_ALLOWED', 'only model_profile=default is allowed', { allowlist: ['default'] });
  if (raw.material_bindings !== undefined) {
    if (!Array.isArray(raw.material_bindings) || raw.material_bindings.length > 100 || raw.material_bindings.some(b => !isObject(b) || !nonEmpty(b.stage_id) || Object.keys(b).some(k => k !== 'stage_id')) || new Set(raw.material_bindings?.map?.(b => b?.stage_id)).size !== raw.material_bindings.length) {
      problems.push('material_bindings: expected unique stage_id objects (maximum 100)');
    }
  }
  if (problems.length) throw new TypedError('VALIDATION_ERROR', `input does not satisfy evaluate_next_goal ${GOAL_CONTRACT_VERSION}`, { problems });
  const chars = JSON.stringify({ conversation_objective: raw.conversation_objective, conversation_state: raw.conversation_state, material_bindings: raw.material_bindings }).length;
  if (chars > GOAL_MAX_INPUT_CHARS) throw new TypedError('INPUT_TOO_LARGE', `input exceeds ${GOAL_MAX_INPUT_CHARS} characters`, { input_chars: chars, limit_chars: GOAL_MAX_INPUT_CHARS });
  return raw;
}

function resultError(err, requestId) {
  if (err instanceof TypedError) return { isError: true, data: { error: { code: err.code, message: err.message, ...(err.details || {}) }, request_id: requestId } };
  return { isError: true, data: { error: { code: 'INTERNAL', message: 'unexpected goal handler error' }, request_id: requestId } };
}

function successfulResult({ status, goal = null, reason = '', requestId, input, started, model = null, attempts = 0, usage = { source: 'none' }, execution = null }) {
  const revision = input.conversation_revision;
  const data = {
    status,
    ...(input.material_bindings ? { execution } : {}),
    requires_message: status === 'goal_ready',
    goal,
    reason,
    request_id: requestId,
    conversation_revision: revision,
    generation: { model, prompt_version: GOAL_PROMPT_VERSION, contract_version: GOAL_CONTRACT_VERSION, attempts },
    usage,
    timing: { total_ms: Date.now() - started },
    warnings: [],
  };
  return { isError: false, data, meta: { request_id: requestId, trace_id: input.trace_id ?? requestId, conversation_revision: revision, generation: data.generation, usage, timing: data.timing } };
}

export async function evaluateNextGoal(raw, env = {}) {
  const started = Date.now();
  const requestId = requestIdOf(raw);
  try {
    const input = normalizeGoalInput(raw);
    if (hasContactBan(input.conversation_state)) {
      return successfulResult({ status: 'do_not_contact', reason: 'contact ban in conversation_state', requestId, input, started });
    }
    const { messages } = renderGoalPrompt({ ...input, language: input.language || 'ru' });
    const schema = buildGoalDecisionSchema(input.material_bindings ?? null);
    const rejected = [];
    for (let attempt = 1; attempt <= GOAL_MAX_ATTEMPTS; attempt += 1) {
      const callMessages = messages.slice();
      if (attempt > 1) callMessages[callMessages.length - 1] = { role: 'user', content: `${callMessages.at(-1).content}\n\nPrevious answer failed validation: ${rejected.at(-1).join('; ')}. Return corrected JSON only.` };
      let response;
      try {
        response = await ladderChat({ baseUrl: env.LLM_LADDER_URL, token: env.LLM_LADDER_TOKEN, model: GOAL_LADDER_NAME, messages: callMessages, temperature: 0, maxTokens: 400, responseFormat: { type: 'json_schema', json_schema: { name: 'next_communication_goal', strict: true, schema } }, app: 'communication-skills-goal', traceId: input.trace_id || requestId, totalTimeoutMs: remainingMethodBudget(started, attempt - 1) });
      } catch (e) {
        if (e instanceof LadderError) throw new TypedError('LLM_UNAVAILABLE', `shared ladder ${GOAL_LADDER_NAME} unavailable: ${e.message}`, { attempts: attempt });
        throw e;
      }
      const checked = validateGoalDecision(parseLooseJson(response.content), input.material_bindings ?? null);
      remainingMethodBudget(started, attempt);
      if (checked.ok) {
        return successfulResult({
          ...checked.value,
          requestId,
          input,
          started,
          model: response.model,
          attempts: attempt,
          usage: { source: 'ladder', ...(Number.isFinite(response.usage?.prompt_tokens) ? { input_tokens: response.usage.prompt_tokens } : {}), ...(Number.isFinite(response.usage?.completion_tokens) ? { output_tokens: response.usage.completion_tokens } : {}) },
        });
      }
      rejected.push(checked.problems);
    }
    throw new TypedError('GOAL_REJECTED', `goal decision failed validation after ${GOAL_MAX_ATTEMPTS} attempts`, { attempts: GOAL_MAX_ATTEMPTS, rejections: rejected });
  } catch (e) {
    logEvent('goal', { request_id: requestId, code: e.code || 'INTERNAL' });
    return resultError(e, requestId);
  }
}
