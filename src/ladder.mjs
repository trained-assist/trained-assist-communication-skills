'use strict';

// Client for the SHARED trained-assist-llm-ladder (POST {base}/v1/chat/completions).
// The sandbox points this at scripts/sandbox/fake-ladder.mjs, which speaks the same
// HTTP contract — the code path exercised in the sandbox is the one that ships.
// Own model keys / model configs / fallback chains are forbidden (ADR-0001).

const ENDPOINT = '/v1/chat/completions';

export class LadderError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'LadderError';
    this.status = status;
  }
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

/**
 * One ladder call. Returns { content, model, usage }.
 * Any non-2xx / network / timeout / empty answer → LadderError (the caller maps it to
 * a typed LLM_UNAVAILABLE error; there is deliberately NO client-side retry here —
 * the ladder already retries its rungs internally and the budget belongs to the caller).
 *
 * `responseFormat` is passed through untouched. The ladder forwards it to the
 * provider and, on a 400 that names structured outputs, retries the SAME rung
 * without it — so a schema we send is a request, never a reason to lose the call.
 * The caller still validates the answer itself (issue #10 §7).
 */
export async function ladderChat({
  baseUrl,
  token,
  model,
  messages,
  temperature = 0.7,
  maxTokens = 800,
  timeoutMs = 20000,
  app = 'communication-skills',
  responseFormat = null,
} = {}) {
  if (!baseUrl) throw new LadderError('LLM_LADDER_URL не задан — общая лестница недоступна');
  if (!Array.isArray(messages) || !messages.length) throw new LadderError('ladderChat: пустой messages');

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ladder_timeout_ms: timeoutMs,
  };
  if (responseFormat) body.response_format = responseFormat;

  let res;
  try {
    res = await fetch(joinUrl(baseUrl, ENDPOINT), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token || 'missing-token'}`,
        'Content-Type': 'application/json',
        'x-ladder-app': app,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
  } catch (e) {
    throw new LadderError(`лестница недоступна: ${e.name === 'TimeoutError' ? 'таймаут' : e.message}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const txt = await res.text();
      try {
        const parsed = JSON.parse(txt);
        detail = parsed?.error?.message || '';
      } catch { detail = txt.slice(0, 200); }
    } catch { /* body unreadable */ }
    throw new LadderError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status });
  }

  let data;
  try { data = await res.json(); } catch (e) { throw new LadderError(`неразбираемый ответ лестницы: ${e.message}`); }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LadderError('пустой ответ лестницы (нет choices[0].message.content)');
  }
  return { content, model: data.model || model || null, usage: data.usage || null };
}
