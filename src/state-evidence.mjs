'use strict';

// Optional source_id/quote evidence uses the input already supplied by callers.
// Other schema shapes remain generic; this does not infer domain achievements.
function sourceText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value) + '\n' + Object.values(value).map(sourceText).join('\n');
}

export function validateStateEvidence(state, input) {
  if (input.evidence_source_refs === undefined) return { ok: true, problems: [] };
  const sources = new Map();
  if (input.conversation_history?.format === 'messages') {
    for (const message of input.conversation_history.messages) {
      if (message.id) sources.set(message.id, message.text);
    }
  }
  for (const [id, pointer] of Object.entries(input.evidence_source_refs)) {
    const value = resolveEvidencePointer(input, pointer);
    if (value !== undefined && value !== null) sources.set(id, sourceText(value));
  }
  const problems = [];
  function visit(value, path) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((entry, i) => visit(entry, `${path}[${i}]`)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidence' && Array.isArray(child)) {
        child.forEach((entry, i) => {
          if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'source_id')) return;
          const source = sources.get(entry.source_id);
          if (typeof source !== 'string' || typeof entry.quote !== 'string' || !entry.quote.trim() || !source.includes(entry.quote)) {
            // Never echo a rejected quote or profile text in diagnostics/logs.
            problems.push(`${path}.evidence[${i}]: source_id must identify a supplied factual source; copy a nonempty quote exactly from that source, without paraphrasing or changing whitespace.`);
          }
        });
      }
      visit(child, `${path}.${key}`);
    }
  }
  visit(state, 'state');
  return { ok: problems.length === 0, problems };
}

export function resolveEvidencePointer(input, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/u.test(pointer)) return undefined;
  let current = input;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
