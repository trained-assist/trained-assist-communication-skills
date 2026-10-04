'use strict';

import { ladderChat, LadderError } from './ladder.mjs';
import { parseLooseJson } from './intent-schema.mjs';
import { buildStateResultSchema, validateStateResult, validateSupportedStateSchema } from './state-schema.mjs';
import { renderStatePrompt } from './state-prompt.mjs';
import { TypedError, logEvent } from './typed-error.mjs';

export const STATE_CONTRACT_VERSION = 'v1';
export const STATE_PROMPT_VERSION = 'sp1';
export const STATE_LADDER_NAME = globalThis.process?.env?.LLM_LADDER_NAME || 'service:classify';
export const STATE_MAX_ATTEMPTS = 2;
export const STATE_MAX_INPUT_CHARS = 120000;
export const STATE_MAX_SCHEMA_CHARS = 24000;

const MODEL_PROFILES = {
  default: { temperature: 0, maxTokens: 1200 },
};

const SPEAKER_ROLES = new Set(['sender', 'partner', 'other']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && !!v.trim();
}

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

function requestIdOf(raw) {
  return nonEmptyString(raw?.request_id) ? raw.request_id.trim() : newRequestId();
}

function sizeOf(value) {
  if (value === undefined || value === null) return 0;
  return (typeof value === 'string' ? value : JSON.stringify(value)).length;
}

export function normalizeStateInput(raw) {
  if (!isPlainObject(raw)) {
    throw new TypedError('VALIDATION_ERROR', 'аргументы tools/call должны быть объектом', { problems: ['arguments: ожидается объект'] });
  }
  const problems = [];

  const history = raw.conversation_history;
  if (!isPlainObject(history) || (history.format !== 'messages' && history.format !== 'text')) {
    problems.push('conversation_history.format: требуется tagged union {format:"messages"|"text"}');
  } else if (history.format === 'messages') {
    if (!Array.isArray(history.messages)) {
      problems.push('conversation_history.messages: требуется массив');
    } else {
      history.messages.forEach((m, i) => {
        if (!isPlainObject(m)) {
          problems.push(`conversation_history.messages[${i}]: ожидается объект`);
          return;
        }
        if (m.id !== undefined && !nonEmptyString(m.id)) problems.push(`conversation_history.messages[${i}].id: если задан — непустая строка`);
        if (!SPEAKER_ROLES.has(m.speaker)) problems.push(`conversation_history.messages[${i}].speaker: требуется sender|partner|other`);
        if (!nonEmptyString(m.text)) problems.push(`conversation_history.messages[${i}].text: требуется непустая строка`);
        if (m.timestamp !== undefined && !nonEmptyString(m.timestamp)) problems.push(`conversation_history.messages[${i}].timestamp: если задан — непустая строка`);
      });
    }
  } else if (typeof history.text !== 'string') {
    problems.push('conversation_history.text: требуется строка');
  }

  if (!isPlainObject(raw.state_schema)) {
    problems.push('state_schema: требуется объект ограниченной JSON Schema-подобной формы');
  } else {
    const supported = validateSupportedStateSchema(raw.state_schema);
    problems.push(...supported.problems);
  }

  if (raw.options !== undefined && raw.options !== null && !isPlainObject(raw.options)) {
    problems.push('options: если задан — объект');
  } else if (isPlainObject(raw.options) && raw.options.language !== undefined) {
    if (typeof raw.options.language !== 'string' || !/^[a-z]{2}(-[A-Za-z0-9]{2,12})?$/i.test(raw.options.language.trim())) {
      problems.push('options.language: требуется явный код вида ru или en');
    }
  }

  if (raw.conversation_revision !== undefined && !nonEmptyString(raw.conversation_revision)) {
    problems.push('conversation_revision: если задан — непустая строка');
  }

  if (problems.length) {
    throw new TypedError('VALIDATION_ERROR', `вход не проходит контракт extract_conversation_state ${STATE_CONTRACT_VERSION}`, { problems });
  }
  return raw;
}

export function stateInputMetrics(input) {
  const history = input.conversation_history;
  const historyChars = history.format === 'messages'
    ? history.messages.reduce((sum, m) => sum + sizeOf(m.text), 0)
    : sizeOf(history.text);
  const schemaChars = sizeOf(input.state_schema);
  return {
    history_messages: history.format === 'messages' ? history.messages.length : 1,
    history_chars: historyChars,
    schema_chars: schemaChars,
    total_chars: historyChars + schemaChars,
    coverage: {
      history_full: true,
      truncated: false,
    },
  };
}

function assertFits(metrics, requestId) {
  if (metrics.schema_chars > STATE_MAX_SCHEMA_CHARS) {
    throw new TypedError('VALIDATION_ERROR', `state_schema ${metrics.schema_chars} символов > лимита ${STATE_MAX_SCHEMA_CHARS}`, { request_id: requestId, problems: ['state_schema: слишком большая схема'] });
  }
  if (metrics.total_chars > STATE_MAX_INPUT_CHARS) {
    throw new TypedError('INPUT_TOO_LARGE', `вход ${metrics.total_chars} символов > лимита ${STATE_MAX_INPUT_CHARS}: сжатие в MVP не включено`, { request_id: requestId, sizes: { total_chars: metrics.total_chars, limit_chars: STATE_MAX_INPUT_CHARS, history_chars: metrics.history_chars, schema_chars: metrics.schema_chars } });
  }
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
  return { isError: true, data: { error: { code: 'INTERNAL', message: 'непредвиденная ошибка state handler' }, request_id: requestId } };
}

export async function extractConversationState(raw, env = {}) {
  const t0 = Date.now();
  const requestId = requestIdOf(raw);
  const traceId = nonEmptyString(raw?.trace_id) ? raw.trace_id.trim() : requestId;

  try {
    const input = normalizeStateInput(raw);
    const metrics = stateInputMetrics(input);
    assertFits(metrics, requestId);
    const profile = resolveModelProfile(input.model_profile);
    const resultSchema = buildStateResultSchema(input.state_schema);
    const { messages, language } = renderStatePrompt(input);
    const rejections = [];

    for (let attempt = 1; attempt <= STATE_MAX_ATTEMPTS; attempt += 1) {
      const call = messages.slice();
      if (attempt > 1) {
        const lastUser = call[call.length - 1];
        call[call.length - 1] = {
          role: 'user',
          content: `${lastUser.content}\n\nPrevious attempt failed validation: ${rejections[rejections.length - 1].problems.join('; ')}. Return corrected JSON only.`,
        };
      }

      let res;
      try {
        res = await ladderChat({
          baseUrl: env.LLM_LADDER_URL,
          token: env.LLM_LADDER_TOKEN,
          model: STATE_LADDER_NAME,
          messages: call,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          responseFormat: {
            type: 'json_schema',
            json_schema: { name: 'conversation_state', strict: true, schema: resultSchema },
          },
          app: 'communication-skills-state',
        });
      } catch (e) {
        if (e instanceof LadderError) {
          logEvent('state', { request_id: requestId, code: 'LLM_UNAVAILABLE', attempts: attempt });
          throw new TypedError('LLM_UNAVAILABLE', `общая лестница ${STATE_LADDER_NAME} недоступна: ${e.message}`, { attempts: attempt });
        }
        throw e;
      }

      const parsed = parseLooseJson(res.content);
      const checked = validateStateResult(parsed, input.state_schema);
      if (checked.ok) {
        const data = {
          state: checked.value.state,
          request_id: requestId,
          conversation_revision: input.conversation_revision ?? null,
          generation: { model: res.model, prompt_version: STATE_PROMPT_VERSION, contract_version: STATE_CONTRACT_VERSION, attempts: attempt },
          usage: usageFromLadder(res.usage),
          timing: { total_ms: Date.now() - t0 },
          input_metrics: metrics,
          warnings: [],
        };
        const meta = {
          request_id: requestId,
          trace_id: traceId,
          conversation_revision: data.conversation_revision,
          language,
          generation: data.generation,
          usage: data.usage,
          timing: data.timing,
          input_metrics: metrics,
          warnings: data.warnings,
        };
        logEvent('state', { request_id: requestId, status: 'extracted', attempts: attempt, input_chars: metrics.total_chars, total_ms: data.timing.total_ms });
        return { isError: false, data, meta };
      }

      rejections.push({ attempt, problems: checked.problems });
      logEvent('state', { request_id: requestId, status: 'guard_rejected', attempt });
    }

    throw new TypedError('STATE_REJECTED', `state output failed validation after ${STATE_MAX_ATTEMPTS} attempts`, { attempts: STATE_MAX_ATTEMPTS, rejections });
  } catch (e) {
    return errorResult(e, requestId);
  }
}
