'use strict';

// MCP entrypoint (ADR-0001): initialize / tools/list / tools/call — тонкая дверь
// над одним handler'ем (src/handler.mjs). Путь закреплён песочницей и CI:
// переопределяется COMMUNICATION_MCP_ENTRYPOINT, имя сервера — trained-assist-communication-skills.

import { generateNextMessage, evaluateMessageQuality, CONTRACT_VERSION } from '../handler.mjs';

const SERVER_NAME = 'trained-assist-communication-skills';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

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
      messages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, speaker: { type: 'string', enum: ['sender', 'partner', 'other'] }, text: { type: 'string' }, timestamp: { type: 'string' }, speaker_name: { type: 'string' } }, required: ['speaker', 'text'] } },
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

const TOOLS = [
  {
    name: 'generate_next_message_to_conversation_partner',
    description: 'Пишет ОДНО следующее сообщение по явно заданной цели (goal). Не выбирает шаг процесса и ничего не отправляет — возвращает черновик. После генерации результат прогоняется через guard; при отклонении — повтор в пределах общего retry budget (2 попытки всего).',
    inputSchema: {
      type: 'object',
      properties: INPUT_COMMON,
      required: ['goal', 'communication_style', 'language', 'conversation_history'],
    },
  },
  {
    name: 'evaluate_message_quality',
    description: 'Тот же вход плюс draft_message: судит готовое сообщение и возвращает вердикт ok|repeat|low_quality|style_mismatch|constraint_violated с причинами. Ничего не генерирует и модель не тратит. Тот же код guard, второй вход — для чужих генераторов.',
    inputSchema: {
      type: 'object',
      properties: { ...INPUT_COMMON, draft_message: { type: 'string', description: 'Проверяемое сообщение целиком.' } },
      required: ['goal', 'communication_style', 'language', 'conversation_history', 'draft_message'],
    },
  },
];

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function ok(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function toolResult(out) {
  return {
    content: [{ type: 'text', text: JSON.stringify(out.data) }],
    structuredContent: out.data,
    ...(out.isError ? { isError: true } : {}),
  };
}

async function callTool(name, args) {
  if (name === 'generate_next_message_to_conversation_partner') {
    return generateNextMessage(args, process.env);
  }
  if (name === 'evaluate_message_quality') {
    return evaluateMessageQuality(args);
  }
  return null;
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, contractVersion: CONTRACT_VERSION },
      });
    case 'notifications/initialized':
      return undefined;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const out = await callTool(name, args);
      if (!out) {
        return ok(id, toolResult({ isError: true, data: { error: { code: 'UNKNOWN_TOOL', message: `неизвестный инструмент: ${name}` } } }));
      }
      return ok(id, toolResult(out));
    }
    default:
      if (id === undefined) return undefined;
      return fail(id, -32601, `communication-skills: unknown method ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `communication-skills: parse error ${e.message}` } });
      continue;
    }
    const run = (m) => handle(m).catch((e) => {
      if (m && m.id !== undefined) fail(m.id, -32603, `communication-skills: ${e.message}`);
    });
    if (Array.isArray(msg)) msg.forEach(run);
    else run(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
