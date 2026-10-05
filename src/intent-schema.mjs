'use strict';

// The two-field contract of `resolve_user_intent` (issue #10 §2), as pure code.
//
// TWO FACTS DRIVE THIS FILE:
//
//  1. The public answer is EXACTLY `{user_goal, decision}`. No `route`,
//     `intent.kind`, `confidence`, `reason`, `status` — those are either guesses
//     dressed as fields or a second contract to keep in sync. Diagnostics travel
//     in `_meta` / HTTP headers instead (see intent-handler.mjs), so a caller
//     parsing this shape cannot accidentally depend on a diagnostic.
//  2. The set of legal `decision` values is NOT known to this service. The caller
//     passes `decision_options`; the method only ever adds the reserved
//     `no_matching_option`. So the enum is BUILT PER REQUEST from the caller's
//     ids. Swapping the catalog changes the allowed ids with zero code change —
//     which is the whole point of a universal resolver, and the first thing the
//     acceptance suite checks.
//
// Provider JSON Schema is NOT trusted: `validateIntentOutput` re-checks the shape
// after the model answers (issue #10 §7 — «валидация обязательна даже с provider
// JSON Schema»). A schema the provider honours is a convenience; a schema we
// check is a guarantee.

/** Reserved value the service adds itself. A caller may not pass it as an option id. */
export const NO_MATCHING_OPTION = 'no_matching_option';

/** Below this a `user_goal` is not a formulated goal — it is a fragment or an echo. */
export const MIN_GOAL_CHARS = 10;

/** The exact key set of a successful public answer. */
export const RESULT_FIELDS = Object.freeze(['user_goal', 'decision']);

function uniq(values) {
  return [...new Set(values)];
}

/**
 * JSON Schema for the model answer, built from the caller's ids.
 * `additionalProperties:false` + both properties `required` is what lets a
 * provider apply it in strict mode; the same three constraints are what
 * `validateIntentOutput` re-checks locally.
 *
 * @param {string[]} optionIds caller-supplied ids (validated elsewhere)
 * @returns {object} JSON Schema
 */
export function buildDecisionOutputSchema(optionIds) {
  const ids = Array.isArray(optionIds) ? optionIds.filter((v) => typeof v === 'string' && v.trim()) : [];
  return {
    type: 'object',
    additionalProperties: false,
    required: [...RESULT_FIELDS],
    properties: {
      user_goal: {
        type: 'string',
        minLength: MIN_GOAL_CHARS,
        description: 'Формулировка желания пользователя на языке options.language. Сохраняет подзадачи, отрицания, ограничения и требуемый результат; не подменяет желание возможностями приложения и не добавляет невыраженных действий.',
      },
      decision: {
        type: 'string',
        enum: uniq([...ids, NO_MATCHING_OPTION]),
        description: 'Ровно один id из переданных decision_options либо no_matching_option. Свой вариант не придумывать.',
      },
    },
  };
}

/** MCP `outputSchema` for the tool — same two fields, published for clients. */
export function buildDecisionResultSchema() {
  const schema = buildDecisionOutputSchema([]);
  delete schema.properties.decision.enum;
  schema.properties.decision.minLength = 1;
  return schema;
}

/**
 * MCP `inputSchema` for the tool. `decision_options` carries the closed list the
 * whole method is about, so it is spelled out: id + a meaningful description are
 * both required, `applicability` is optional (issue #10 §3 — «Decision 3» без
 * описания для выбора не годится).
 */
export function buildIntentInputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      schema_version: { type: 'string', description: 'Версия контракта вызывающей стороны; возвращается как есть.' },
      request_id: { type: 'string', description: 'Корреляция; возвращается в диагностике.' },
      trace_id: { type: 'string', description: 'Корреляция; возвращается в диагностике.' },
      input_bundle: {
        type: 'object',
        description: 'Уже собранный пакет ввода: события в исходном порядке с ids + манифест вложений. Буферизация и дебаунс — вне метода.',
        properties: {
          id: { type: 'string', description: 'Идентификатор пакета.' },
          version: { type: 'string', description: 'Меняется при любом изменении пакета; возвращается в диагностике, чтобы вызывающая сторона не применила устаревший результат.' },
          events: {
            type: 'array',
            description: 'Пользовательские сообщения, подписи, транскрипты. Ни один блок не отбрасывается.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string', description: 'text | transcript | ocr | note | tool_result.' },
                author: { type: 'string', description: 'Кто автор: user | assistant | system | tool.' },
                text: { type: 'string' },
                origin: { type: 'string', description: 'user_command | forwarded_content | document_content — пересланный текст и содержимое документа НЕ являются командой пользователя.' },
                timestamp: { type: 'string' },
              },
              required: ['id', 'type', 'author', 'text'],
            },
          },
          attachments: {
            type: 'array',
            description: 'Манифест вложений. Манифест без текста НЕ равен прочитанному файлу.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                mime_type: { type: 'string' },
                size_bytes: { type: 'number' },
                content_hash: { type: 'string' },
                resource_ref: { type: 'string', description: 'Непрозрачная ссылка для авторизованного resolver вызывающей стороны. Этот сервис её не открывает.' },
                content_status: { type: 'string', enum: ['text_available', 'ocr_available', 'transcript_available', 'metadata_only', 'unavailable'] },
                text: { type: 'string', description: 'Извлечённый текст/OCR/транскрипт, если он уже есть.' },
              },
              required: ['id', 'name', 'content_status'],
            },
          },
        },
        required: ['id', 'events'],
      },
      recipient: {
        type: 'object',
        description: 'Адресат обращения: кто он, чем занимается, зона ответственности.',
        properties: {
          role: { type: 'string' },
          persona: { type: 'string' },
          scope: { type: 'string' },
        },
        required: ['role'],
      },
      decision_options: {
        type: 'array',
        description: 'Закрытый список решений, который вправе выбрать этот метод. Собственные варианты метод не добавляет.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Стабильный id. Не может быть no_matching_option.' },
            description: { type: 'string', description: 'Содержательное описание: что именно делает этот вариант.' },
            applicability: { type: 'string', description: 'Необязательные условия применения.' },
          },
          required: ['id', 'description'],
        },
      },
      decision_priority: {
        type: 'array',
        description: 'Явный порядок предпочтения между применимыми вариантами. Приоритет выбирает между подходящими, но не делает неподходящий подходящим.',
        items: { type: 'string' },
      },
      capabilities: {
        type: 'array',
        description: 'Каталог доступных возможностей с короткими описаниями. Помогает интерпретировать запрос, но НЕ заменяет decision_options.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            availability: { type: 'string' },
            version: { type: 'string' },
          },
          required: ['id', 'title', 'description'],
        },
      },
      dialog_context: {
        type: 'object',
        description: 'Прошлый контекст: нужны для «да», «продолжай», «сократи», «а это?».',
        properties: {
          history: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, author: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' } },
              required: ['text'],
            },
          },
          active_tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, goal: { type: 'string' }, expected_answer: { type: 'string' } },
              required: ['goal'],
            },
          },
        },
      },
      runtime_facts: {
        type: 'array',
        description: 'Факты о текущем состоянии с временем актуальности, предоставленные вызывающей стороной. Без них вопрос о времени/здоровье/завершении run не имеет основания.',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, value: { type: 'string' }, as_of: { type: 'string' } },
          required: ['key', 'value'],
        },
      },
      source_refs: {
        type: 'array',
        description: 'Ссылки на источники. Не открываются автоматически ради намерения.',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, kind: { type: 'string' }, resource_ref: { type: 'string' }, note: { type: 'string' } },
          required: ['id'],
        },
      },
      options: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'Язык формулировки user_goal. Если не задан — определяется по письму пользовательского текста.' },
        },
      },
      model_profile: { type: 'string', description: 'Только серверный allowlist; произвольные модели/ключи не принимаются.' },
    },
    required: ['input_bundle', 'recipient', 'decision_options'],
  };
}

/**
 * Loose JSON extraction: a small model may fence or wrap the answer in prose.
 * Same three steps the ladder itself uses, so behaviour does not diverge.
 * @returns {unknown|undefined} undefined = not JSON at all
 */
export function parseLooseJson(text) {
  const raw = String(text ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(raw); } catch { /* try the embedded object */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return undefined; } }
  return undefined;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Server-side validation of the model answer. Runs regardless of what the
 * provider did with our schema.
 *
 * @param {unknown} raw parsed model output
 * @param {string[]} allowedIds caller ids + NO_MATCHING_OPTION
 * @returns {{ok: boolean, value?: {user_goal: string, decision: string}, problems: string[]}}
 */
export function validateIntentOutput(raw, allowedIds) {
  const problems = [];
  const allowed = new Set([...(Array.isArray(allowedIds) ? allowedIds : []), NO_MATCHING_OPTION]);

  if (!isPlainObject(raw)) {
    return { ok: false, problems: [`ответ не объект JSON: ${typeof raw === 'string' ? 'строка' : Array.isArray(raw) ? 'массив' : typeof raw}`] };
  }

  const keys = Object.keys(raw);
  const extra = keys.filter((k) => !RESULT_FIELDS.includes(k));
  if (extra.length) problems.push(`лишние поля в ответе: ${extra.join(', ')} (ожидаются ровно ${RESULT_FIELDS.join(', ')})`);
  for (const field of RESULT_FIELDS) {
    if (!(field in raw)) problems.push(`нет обязательного поля ${field}`);
  }

  const goal = typeof raw.user_goal === 'string' ? raw.user_goal.trim() : '';
  if (typeof raw.user_goal === 'string') {
    if (goal.length < MIN_GOAL_CHARS) problems.push(`user_goal короче ${MIN_GOAL_CHARS} символов (получено ${goal.length})`);
  } else if (raw.user_goal !== undefined) {
    problems.push('user_goal не строка');
  }

  const decision = typeof raw.decision === 'string' ? raw.decision.trim() : '';
  if (typeof raw.decision === 'string') {
    if (!decision) problems.push('decision пустая');
    else if (!allowed.has(decision)) problems.push(`decision="${decision}" не входит в разрешённые: ${[...allowed].join(', ')}`);
  } else if (raw.decision !== undefined) {
    problems.push('decision не строка');
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { user_goal: goal, decision }, problems: [] };
}
