'use strict';

// The MCP conversation, free of any I/O. `src/index.mjs` (Worker/HTTP) and
// `src/mcp/entrypoint.mjs` (stdio) both drive THIS — that is what keeps
// «один handler, две двери» true after the port (ADR-0001).
//
// Everything here is pure: take a parsed JSON-RPC message + deps, return the
// JSON-RPC reply (or `undefined` for a notification). No fetch, no fs, no env.

import { buildIntentInputSchema, buildDecisionResultSchema } from '../intent-schema.mjs';
import { buildStateResultSchema } from '../state-schema.mjs';
import { buildGoalResultSchema } from '../goal-schema.mjs';
import { buildComposeAnswerSchema } from '../compose-schema.mjs';

export const SERVER_NAME = 'trained-assist-communication-skills';
export const SERVER_VERSION = '0.3.0';
export const PROTOCOL_VERSION = '2024-11-05';

export function toolResult(out) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(out.data) }],
    structuredContent: out.data,
    ...(out.isError ? { isError: true } : {}),
  };
  // Diagnostics ride in `_meta` (JSON-RPC `Result._meta`), never in the payload:
  // the resolver's public answer is exactly two fields, and a caller that parses
  // `structuredContent` must not be able to depend on a diagnostic.
  if (out.meta) result._meta = out.meta;
  return result;
}

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

const INPUT_COMMON = {
  goal: {
    type: 'object',
    description: 'Цель ЭТОГО сообщения: что должен сделать следующий ход. Не стратегия кампании.',
    properties: {
      instruction: { type: 'string', description: 'Что именно должно быть в сообщении.' },
      required_points: { type: 'array', items: { type: 'string' }, description: 'Пункты, которые обязаны быть в сообщении; каждый должен опираться на подтверждённый факт, иначе needs_context.' },
      forbidden_points: { type: 'array', items: { type: 'string' }, description: 'Чего сообщение не должно касаться.' },
    },
    required: ['instruction'],
  },
  communication_style: {
    type: 'object',
    description: 'Только голос, тон, обращение, степень формальности. Не может менять цель или добавлять требования.',
    properties: {
      instructions: { type: 'string' },
      examples: { type: 'array', items: { type: 'string' } },
    },
    required: ['instructions'],
  },
  language: { type: 'string', description: 'Явный код языка сообщения: ru, en. Неявных переключений по языку резюме нет.' },
  conversation_history: {
    type: 'object',
    description: 'Tagged union. {format:"messages", messages:[{id?, speaker:"sender"|"partner"|"other", text, timestamp?, speaker_name?}]} — порядок авторитетен, пустой массив = первое сообщение; либо {format:"text", text, speaker_labels:{sender,partner}, timezone?} — при неясных ролях возвращается needs_context, роли не выдумываются.',
    properties: {
      format: { type: 'string', enum: ['messages', 'text'] },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            speaker: { type: 'string', enum: ['sender', 'partner', 'other'] },
            text: { type: 'string' },
            timestamp: { type: 'string' },
            speaker_name: { type: 'string' },
          },
          required: ['speaker', 'text'],
        },
      },
      text: { type: 'string' },
      speaker_labels: { type: 'object', properties: { sender: { type: 'string' }, partner: { type: 'string' } } },
      timezone: { type: 'string' },
    },
    required: ['format'],
  },
  partner_profile: {
    type: 'object',
    description: 'Профиль собеседника: {format:"text", text} или структурированные факты. Пустой профиль допустим и обозначается явно. Резюме — один вид профиля.',
  },
  sender_profile: {
    type: 'object',
    description: 'Имя, роль, организация, подпись отправителя. Без имени не представляться вымышленным.',
  },
  context: {
    type: 'object',
    description: 'Подтверждённые условия: вакансия/предложение, доступные слоты, ссылки, факты диалога, нерешённые вопросы. Только подтверждённое — отсюда берутся факты для сообщения.',
  },
  constraints: {
    type: 'object',
    description: 'Ограничения сильнее стиля и цели: max_characters, max_questions, forbidden_claims, required_verbatim_blocks, preserve_links, channel_format.',
    properties: {
      max_characters: { type: 'number' },
      max_questions: { type: 'number' },
      forbidden_claims: { type: 'array', items: { type: 'string' } },
      required_verbatim_blocks: { type: 'array', items: { type: 'string' } },
      preserve_links: { type: 'boolean' },
      channel_format: { type: 'string' },
    },
  },
  request_id: { type: 'string', description: 'Корреляция; возвращается в ответе.' },
  trace_id: { type: 'string' },
  context_revision: { type: 'string', description: 'Защита от устаревшего черновика: возвращается как есть.' },
  model_profile: { type: 'string', description: 'Только серверный allowlist (R8); произвольные модели/ключи не принимаются.' },
};

const STATE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    request_id: { type: 'string', description: 'Correlation id; echoed in the response.' },
    trace_id: { type: 'string', description: 'Trace id; returned in diagnostics.' },
    conversation_revision: { type: 'string', description: 'Caller revision of the history. Echoed so stale extraction results can be discarded.' },
    conversation_history: INPUT_COMMON.conversation_history,
    extraction_instructions: { type: 'string' },
    evidence_source_refs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional source ID to JSON pointer mapping into supplied input. Enables exact quote provenance checks and repair without duplicating source text.' },
    partner_profile: { type: ['object', 'string'] },
    sender_profile: { type: ['object', 'string'] },
    context: { type: ['object', 'string'] },
    communication_plan: { type: ['object', 'string'] },
    state_schema: {
      type: 'object',
      description: 'Small JSON Schema-like subset. Root object schema; supported keywords: type, properties, required, additionalProperties:false, items, enum, min/max string/array/number bounds, description.',
    },
    options: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Language for textual labels inside state when the schema allows them.' },
      },
    },
    model_profile: { type: 'string', description: 'Server allowlist only; concrete model/rung stays in the shared ladder.' },
  },
  required: ['conversation_history', 'state_schema'],
};

const GOAL_INPUT_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    request_id: { type: 'string' }, trace_id: { type: 'string' },
    conversation_revision: { type: 'string', description: 'Revision истории, обработанной state extractor; возвращается для stale-result guard.' },
    conversation_state: { type: 'object', description: 'Результат extract_conversation_state.' },
    language: { type: 'string' }, model_profile: { type: 'string' },
    material_bindings: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['stage_id'], properties: { stage_id: { type: 'string' } } } },
    conversation_objective: { type: 'string', description: 'Верхнеуровневая цель диалога, к которой должен вести следующий ход.' },
  }, required: ['conversation_revision', 'conversation_state', 'conversation_objective'],
};

// next_message_in_dialogue (issue #28) is the one-call alternative to the chain
// above: same dialog, same objective, one ladder call instead of three. It takes
// the writer's material MINUS `goal` (the method formulates the goal itself)
// PLUS `conversation_objective` (the chain's goal step needs it). `goal` is
// accepted but ignored by the compose path — it exists so the internal chain
// fallback has a writer goal to run with.
const COMPOSE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    request_id: { type: 'string' },
    trace_id: { type: 'string' },
    context_revision: { type: 'string', description: 'Revision of the history being composed from. Echoed so a stale draft can be discarded.' },
    conversation_objective: { type: 'string', description: 'High-level objective of the dialog; the next goal is derived from it.' },
    communication_style: INPUT_COMMON.communication_style,
    language: INPUT_COMMON.language,
    conversation_history: INPUT_COMMON.conversation_history,
    partner_profile: INPUT_COMMON.partner_profile,
    sender_profile: INPUT_COMMON.sender_profile,
    context: INPUT_COMMON.context,
    constraints: INPUT_COMMON.constraints,
    goal: INPUT_COMMON.goal,
    material_bindings: GOAL_INPUT_SCHEMA.properties.material_bindings,
    fallback: { type: 'string', enum: ['chain', 'off'], description: 'chain (default): run the existing state → goal → message chain when the one-call answer is unusable. off: return a typed error instead. The chain needs `goal`, so without it a fallback is impossible.' },
    model_profile: { type: 'string', description: 'Server allowlist only; concrete model/rung stays in the shared ladder.' },
  },
  required: ['conversation_objective', 'communication_style', 'language', 'conversation_history'],
};

// The canonical tool (issue #6 §1). `evaluate_message_quality` is intentionally
// NOT exposed over MCP any more: it existed so third-party generators could reuse
// the guard, and no external consumer needs a separate quality tool. The guard is
// still applied internally on every draft — it is not lost, only unexposed.
//
// `extract_conversation_state` is the first step of epic #11's chain:
// history -> state -> next goal -> message. It has its own handler, but shares
// the same Worker doors and ladder discipline.
//
// `resolve_user_intent` (issue #10) formulates the user's goal and picks exactly
// one id from the caller's closed list. Its public answer stays two fields even
// while evaluate_next_goal independently formulates an open goal from state.
//
// `next_message_in_dialogue` (issue #28) does state + goal + message in ONE ladder
// call. It is an experiment measured against the chain above, not a replacement:
// the chain stays the reference and is the automatic fallback on any technical
// failure. It never sends anything and never overrides a contact ban.
export const TOOLS = [
  {
    name: 'next_message_in_dialogue_from_goal',
    description: 'Drafts ONE next outgoing message when you ALREADY have the goal: pass goal + communication_style + language + conversation_history and get a draft. This is the goal-driven variant of next_message_in_dialogue — use that one when there is no goal yet. Returns a draft; does not send it. Never re-asks a settled question, never ignores an open question from the interlocutor, and returns no_message_needed when the interlocutor asked to stop being contacted. After generating, the draft is checked by the guard and regenerated within the shared retry budget (2 attempts total).',
    inputSchema: {
      type: 'object',
      properties: INPUT_COMMON,
      required: ['goal', 'communication_style', 'language', 'conversation_history'],
    },
  },
  {
    name: 'extract_conversation_state',
    description: 'Extract a structured conversation state from the full history using a caller-provided small JSON Schema-like state_schema. Does not choose the next goal, write, or send a message.',
    inputSchema: STATE_INPUT_SCHEMA,
    outputSchema: buildStateResultSchema({ type: 'object', additionalProperties: false, properties: {} }),
  },
  {
    name: 'evaluate_next_goal',
    description: 'Formulate an open-ended next communication goal from the conversation objective and extracted state. Returns wait/no_matching_option/contact-ban outcomes without a writer goal.',
    inputSchema: GOAL_INPUT_SCHEMA,
    outputSchema: buildGoalResultSchema(),
  },
  {
    name: 'resolve_user_intent',
    description: 'Infer the user\'s goal from the supplied input and context, then select exactly one of the caller-provided decision options. Return no_matching_option when none applies. Does not execute the selected decision.',
    inputSchema: buildIntentInputSchema(),
    outputSchema: buildDecisionResultSchema(),
  },
  {
    name: 'next_message_in_dialogue',
    description: 'Drafts ONE next outgoing message when you do NOT have a goal yet: pass conversation_objective and this derives the state, the next goal and the message itself in a single ladder call, instead of calling extract_conversation_state → evaluate_next_goal → next_message_in_dialogue_from_goal. Use next_message_in_dialogue_from_goal instead when the goal is already decided — it is cheaper to reason about because you keep control of the goal. Returns what happened (key_facts with verbatim evidence), the next goal, and the draft. Statuses ready/wait/cannot_compose decide whether a draft exists; do_not_contact is detected server-side before any model call. Never sends anything and never overrides the consumer\'s freshness, duplicate or contact-ban checks. On a technical failure it runs the existing chain as a fallback (fallback:"off" disables that and returns a typed error instead).',
    inputSchema: COMPOSE_INPUT_SCHEMA,
    outputSchema: buildComposeAnswerSchema(),
  },
];

/**
 * One JSON-RPC message in, one reply out (or undefined for a notification).
 * @param {object} msg parsed JSON-RPC message
 * @param {object} deps { tools, handlers, serverName, serverVersion, protocolVersion }
 *   `handlers` maps a tool name to its application function; `generate` is kept as
 *   the default so a driver that only wires the writer keeps working.
 */
export async function handleMcpMessage(msg, env, deps) {
  const { tools, handlers, generate, serverName, serverVersion, protocolVersion } = deps;
  const { id, method, params } = msg || {};

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion || protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
      });
    case 'notifications/initialized':
      return undefined;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools });
    case 'tools/call': {
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return ok(id, toolResult({ isError: true, data: { error: { code: 'UNKNOWN_TOOL', message: `неизвестный инструмент: ${name}` } } }));
      }
      const handler = (handlers && handlers[name]) || generate;
      if (typeof handler !== 'function') {
        return ok(id, toolResult({ isError: true, data: { error: { code: 'HANDLER_NOT_WIRED', message: `инструмент ${name} объявлен, но его handler не подключён` } } }));
      }
      const out = await handler(params?.arguments ?? {}, env);
      return ok(id, toolResult(out));
    }
    default:
      if (id === undefined) return undefined;
      return fail(id, -32601, `${serverName}: unknown method ${method}`);
  }
}
