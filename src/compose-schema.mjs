'use strict';

// JSON Schema and validators for the compose_next_message answer (issue #28).
//
// One ladder call returns three things at once: what happened (key_facts), what
// the next step is (next_goal) and the message text. The shape is deliberately
// flat and the status list is closed — see docs/compose-next-message-contract.md
// for why the nested state/goal/message variant and the extra `action` enum were
// rejected after the prototype.
//
// `do_not_contact` is a SERVER-ONLY status: it is produced by the deterministic
// dialog-state check before any ladder call, exactly like evaluate_next_goal
// does. The model never sees it, so it is absent from the model-facing schema.

export const COMPOSE_STATUSES = Object.freeze(['ready', 'wait', 'cannot_compose', 'do_not_contact']);

/** What the model may return. `do_not_contact` is added by the server, not the model. */
export const COMPOSE_MODEL_STATUSES = Object.freeze(['ready', 'wait', 'cannot_compose']);

export const MAX_KEY_FACTS = 20;
export const MAX_FACT_CHARS = 200;
export const MAX_QUOTE_CHARS = 300;
export const MAX_MESSAGE_CHARS = 4000;

export function buildComposeAnswerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'key_facts', 'next_goal', 'message', 'warnings'],
    properties: {
      status: { type: 'string', enum: [...COMPOSE_MODEL_STATUSES] },
      key_facts: {
        type: 'array',
        maxItems: MAX_KEY_FACTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fact', 'evidence'],
          properties: {
            fact: { type: 'string', minLength: 1, maxLength: MAX_FACT_CHARS, description: 'One short observation about the conversation. No communicative directives, no questions, no plans.' },
            evidence: {
              type: 'object',
              additionalProperties: false,
              required: ['quote'],
              properties: {
                quote: { type: 'string', minLength: 1, maxLength: MAX_QUOTE_CHARS, description: 'Verbatim quote from the supplied history, context or profiles. Copy exactly, including whitespace. Never paraphrase.' },
                message_id: { type: 'string', minLength: 1, description: 'Only when the supplied history messages carry ids. The quote must then come from THAT message.' },
              },
            },
          },
        },
      },
      next_goal: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['instruction', 'required_points', 'forbidden_points'],
        properties: {
          instruction: { type: 'string', minLength: 8, description: 'Open-ended next action, derived from the dialog objective and the conversation so far.' },
          required_points: { type: 'array', items: { type: 'string' }, description: 'Only confirmed facts to mention, preferably short exact quotes. Empty when nothing needs repeating.' },
          forbidden_points: { type: 'array', items: { type: 'string' }, description: 'Prohibitions for the message. Actions belong in instruction.' },
        },
      },
      message: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['text', 'language'],
        properties: {
          text: { type: 'string', maxLength: MAX_MESSAGE_CHARS, description: 'The draft text. Empty/null when nothing should be sent.' },
          language: { type: 'string', description: 'Language code of the text; must match the requested language.' },
        },
      },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Explanations, especially for wait/cannot_compose. Empty when nothing to add.' },
    },
    // The model-facing shape agrees with the validator: a ready answer carries a
    // goal and a message, a non-ready one carries neither.
    anyOf: [
      {
        required: ['message', 'next_goal'],
        properties: { status: { enum: ['ready'] }, message: { type: 'object' }, next_goal: { type: 'object' } },
      },
      {
        properties: {
          status: { enum: ['wait', 'cannot_compose'] },
          message: { type: 'null' },
          next_goal: { type: 'null' },
        },
      },
    ],
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function primarySubtag(code) {
  return String(code).trim().toLowerCase().split('-')[0];
}

/**
 * Shape validation only. Evidence verbatimity and the message guard are separate
 * deterministic passes in the handler: they need the caller's input and the
 * dialog state, and keeping them apart means each failure reason is reported
 * once instead of being folded into a generic "invalid" verdict.
 *
 * @returns {{ok:boolean, value:object|null, problems:string[]}}
 */
export function validateComposeAnswer(raw) {
  const problems = [];
  if (!isPlainObject(raw)) return { ok: false, value: null, problems: ['ответ должен быть JSON-объектом'] };

  for (const key of Object.keys(raw)) {
    if (!['status', 'key_facts', 'next_goal', 'message', 'warnings'].includes(key)) problems.push(`неизвестное поле: ${key}`);
  }

  if (!COMPOSE_STATUSES.includes(raw.status)) {
    problems.push(`status должен быть одним из: ${COMPOSE_MODEL_STATUSES.join(', ')}`);
  }

  const ready = raw.status === 'ready';

  if (!Array.isArray(raw.key_facts)) {
    problems.push('key_facts: требуется массив');
  } else {
    if (raw.key_facts.length > MAX_KEY_FACTS) problems.push(`key_facts: ${raw.key_facts.length} > лимита ${MAX_KEY_FACTS}`);
    raw.key_facts.forEach((fact, i) => {
      const where = `key_facts[${i}]`;
      if (!isPlainObject(fact)) { problems.push(`${where}: ожидается объект`); return; }
      for (const key of Object.keys(fact)) if (!['fact', 'evidence'].includes(key)) problems.push(`${where}: неизвестное поле ${key}`);
      if (typeof fact.fact !== 'string' || !fact.fact.trim()) problems.push(`${where}.fact: требуется непустая строка`);
      else if (fact.fact.length > MAX_FACT_CHARS) problems.push(`${where}.fact: ${fact.fact.length} > лимита ${MAX_FACT_CHARS}`);
      if (!isPlainObject(fact.evidence)) problems.push(`${where}.evidence: ожидается объект`);
    });
  }

  if (raw.next_goal === null || raw.next_goal === undefined) {
    if (ready) problems.push('next_goal: требуется при status=ready');
  } else if (!isPlainObject(raw.next_goal)) {
    problems.push('next_goal: ожидается объект или null');
  } else if (!ready) {
    // A non-ready answer carries no goal: a goal the consumer must not act on is
    // worse than none, because "wait" and "send this" differ in outcome.
    problems.push('next_goal: при status, отличном от ready, требуется null');
  } else {
    for (const key of Object.keys(raw.next_goal)) {
      if (!['instruction', 'required_points', 'forbidden_points'].includes(key)) problems.push(`next_goal: неизвестное поле ${key}`);
    }
    if (typeof raw.next_goal.instruction !== 'string' || raw.next_goal.instruction.trim().length < 8) {
      problems.push('next_goal.instruction: требуется строка от 8 символов');
    }
    for (const field of ['required_points', 'forbidden_points']) {
      if (raw.next_goal[field] !== undefined && (!Array.isArray(raw.next_goal[field]) || raw.next_goal[field].some((item) => typeof item !== 'string'))) {
        problems.push(`next_goal.${field}: требуется массив строк`);
      }
    }
  }

  if (raw.message === null || raw.message === undefined) {
    if (ready) problems.push('message: требуется при status=ready');
  } else if (!isPlainObject(raw.message)) {
    problems.push('message: ожидается объект или null');
  } else if (!ready) {
    // The whole point of wait/cannot_compose is that there is nothing to send.
    // A draft attached to a non-ready status is a contradiction, not a hint.
    problems.push('message: при status, отличном от ready, требуется null');
  } else {
    for (const key of Object.keys(raw.message)) if (!['text', 'language'].includes(key)) problems.push(`message: неизвестное поле ${key}`);
    if (typeof raw.message.text !== 'string' || !raw.message.text.trim()) problems.push('message.text: требуется непустая строка');
    else if (raw.message.text.length > MAX_MESSAGE_CHARS) problems.push(`message.text: ${raw.message.text.length} > лимита ${MAX_MESSAGE_CHARS}`);
    if (typeof raw.message.language !== 'string' || !raw.message.language.trim()) problems.push('message.language: требуется код языка');
  }

  if (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.some((item) => typeof item !== 'string'))) {
    problems.push('warnings: требуется массив строк');
  }

  if (problems.length) return { ok: false, value: null, problems };

  return {
    ok: true,
    value: {
      status: raw.status,
      key_facts: (Array.isArray(raw.key_facts) ? raw.key_facts : []).map((fact) => ({
        fact: String(fact.fact).trim(),
        evidence: {
          quote: fact.evidence?.quote ?? '',
          ...(fact.evidence?.message_id !== undefined ? { message_id: String(fact.evidence.message_id) } : {}),
        },
      })),
      next_goal: isPlainObject(raw.next_goal) ? {
        instruction: raw.next_goal.instruction.trim(),
        required_points: raw.next_goal.required_points ?? [],
        forbidden_points: raw.next_goal.forbidden_points ?? [],
      } : null,
      message: isPlainObject(raw.message) ? { text: raw.message.text, language: String(raw.message.language).trim() } : null,
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    },
    problems,
  };
}

// ───────────────────────── evidence: цитаты только из переданного ─────────────────────────

function collectStrings(value, out) {
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); return; }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) collectStrings(item, out); }
}

/**
 * The only texts a quote may come from: the history the caller supplied plus
 * every string inside the caller's context, profiles, constraints, style and
 * objective. Nothing else exists at call time, so anything else is invented.
 *
 * @returns {{byId:Map<string,string>, all:string}}
 */
export function buildEvidencePool(input) {
  const byId = new Map();
  const parts = [];
  const history = input.conversation_history;
  if (history.format === 'messages') {
    for (const message of history.messages) {
      if (message.id) byId.set(message.id, message.text);
      parts.push(message.text);
    }
  } else {
    parts.push(history.text);
  }
  for (const value of [input.context, input.partner_profile, input.sender_profile, input.constraints, input.communication_style, input.conversation_objective]) {
    collectStrings(value, parts);
  }
  return { byId, all: parts.join('\n') };
}

/**
 * Every quote must be a VERBATIM substring of what the caller actually sent.
 * A paraphrase is not evidence: it is the model's own wording, and the whole
 * point of the field is that a consumer can trust it without re-reading the
 * dialog. With `message_id` the quote must come from that one message.
 *
 * @param {{key_facts:Array}} answer validated answer
 * @param {{byId:Map<string,string>, all:string}} pool
 * @returns {{ok:boolean, problems:string[]}}
 */
export function validateComposeEvidence(answer, pool) {
  const problems = [];
  answer.key_facts.forEach((fact, i) => {
    const where = `key_facts[${i}].evidence`;
    const quote = fact.evidence?.quote ?? '';
    if (!quote.trim()) { problems.push(`${where}.quote: требуется непустая цитата`); return; }
    if (fact.evidence.message_id !== undefined) {
      const source = pool.byId.get(fact.evidence.message_id);
      if (typeof source !== 'string') {
        problems.push(`${where}.message_id: в переданной истории нет сообщения с id ${fact.evidence.message_id}`);
      } else if (!source.includes(quote)) {
        problems.push(`${where}.quote: цитата не дословно совпадает с сообщением ${fact.evidence.message_id}`);
      }
    } else if (!pool.all.includes(quote)) {
      problems.push(`${where}.quote: цитата не найдена дословно в переданных данных`);
    }
  });
  return { ok: problems.length === 0, problems };
}

/** The message language is the caller's declaration, not the model's guess. */
export function messageLanguageMatches(input, message) {
  if (!message) return true;
  return primarySubtag(message.language) === primarySubtag(input.language);
}
