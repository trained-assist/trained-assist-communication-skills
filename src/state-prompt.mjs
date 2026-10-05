'use strict';

function renderHistory(history) {
  if (history.format === 'messages') {
    return history.messages.map((m, i) => {
      const id = m.id ? ` id=${m.id}` : '';
      const ts = m.timestamp ? ` at=${m.timestamp}` : '';
      return `${i + 1}. [${m.speaker}${id}${ts}] ${m.text}`;
    }).join('\n');
  }
  return history.text;
}

export function renderStatePrompt(input) {
  const language = input.options?.language || 'ru';
  const schema = JSON.stringify(input.state_schema);
  const system = [
    'You extract conversation state as strict JSON.',
    'Return exactly one JSON object with a single key: state.',
    'The value of state must validate against the provided schema.',
    'Use only facts present in the conversation history and supplied profile/context. Do not invent facts. Profile facts are not promises or agreements in the conversation. A plan describes desired results, not accomplished facts.',
    'Keep quotes verbatim when the schema asks for quote/source fields. Copy the exact original substring, including whitespace; never paraphrase.',
    ...(input.evidence_source_refs !== undefined ? ['For source_id/quote evidence, use a supplied message id or a source ID from evidence_source_refs. Each reference is a JSON pointer into this input; only that referenced value is factual evidence for that ID. Plans, requirements and instructions outside the referenced value are not evidence.'] : []),
    'If a fact is uncertain, represent uncertainty only if the schema has a field for it; otherwise omit it or use an empty array.',
  ].join('\n');
  const user = [
    `Language for textual labels: ${language}`,
    `Conversation revision: ${input.conversation_revision ?? 'null'}`,
    '',
    ...(input.extraction_instructions ? ['Caller extraction instructions (interpretation of the supplied schema):', input.extraction_instructions, ''] : []),
    ...(input.evidence_source_refs !== undefined ? ['Evidence source references (JSON pointers into input, no duplicated source text):', JSON.stringify(input.evidence_source_refs), ''] : []),
    ...['partner_profile', 'sender_profile', 'context', 'communication_plan'].filter(k => input[k] != null).flatMap(k => {
      const value = input[k];
      if ((k === 'partner_profile' || k === 'sender_profile') && value?.format === 'text' && typeof value.text === 'string') {
        const { text, ...metadata } = value;
        return [k + ':', JSON.stringify(metadata), text, ''];
      }
      return [k + ':', typeof value === 'string' ? value : JSON.stringify(value), ''];
    }),
    'State schema:',
    schema,
    '',
    'Conversation history:',
    renderHistory(input.conversation_history),
    '',
    'Return JSON only.',
  ].join('\n');
  return { language, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}
