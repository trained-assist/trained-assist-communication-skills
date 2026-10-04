'use strict';

// The MCP conversation, free of any I/O. `src/index.mjs` (Worker/HTTP) and
// `src/mcp/entrypoint.mjs` (stdio) both drive THIS — that is what keeps
// «один handler, две двери» true after the port (ADR-0001).
//
// Everything here is pure: take a parsed JSON-RPC message + deps, return the
// JSON-RPC reply (or `undefined` for a notification). No fetch, no fs, no env.

import { buildIntentInputSchema, buildDecisionResultSchema } from '../intent-schema.mjs';

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

// The canonical tool (issue #6 §1). `evaluate_message_quality` is intentionally
// NOT exposed over MCP any more: it existed so third-party generators could reuse
// the guard, and with one tool in scope there is no such consumer. The guard is
// still applied internally on every draft — it is not lost, only unexposed.
//
// The second tool is `resolve_user_intent` (issue #10): it formulates the user's
// goal and picks exactly one id from the caller's closed list. It shares this
// conversation with the writer — same JSON-RPC, same doors — but NOT the same
// handler: two methods, two handlers, one protocol (ADR-0001).
export const TOOLS = [
  {
    name: 'generate_next_message_to_conversation_partner',
    description: 'Drafts ONE next outgoing message from the specified sender to the specified interlocutor, using their profile, dialog history and communication goal. Returns a draft; does not send it. Never re-asks a settled question, never ignores an open question from the interlocutor, and returns no_message_needed when the interlocutor asked to stop being contacted. After generating, the draft is checked by the guard and regenerated within the shared retry budget (2 attempts total).',
    inputSchema: {
      type: 'object',
      properties: INPUT_COMMON,
      required: ['goal', 'communication_style', 'language', 'conversation_history'],
    },
  },
  {
    name: 'resolve_user_intent',
    description: 'Infer the user\'s goal from the supplied input and context, then select exactly one of the caller-provided decision options. Return no_matching_option when none applies. Does not execute the selected decision.',
    inputSchema: buildIntentInputSchema(),
    outputSchema: buildDecisionResultSchema(),
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
