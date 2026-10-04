'use strict';

// FAKE trained-assist-llm-ladder — sandbox only.
//
// Speaks the exact HTTP contract of the real worker (trained-assist-llm-ladder,
// POST {base}/v1/chat/completions), so the sandbox exercises the REAL ladder client
// code path over real HTTP instead of a stubbed function:
//
//   request : Authorization: Bearer <token>, Content-Type: application/json,
//             x-ladder-app: <slug>
//             body     : { model: <ladder name>, messages, temperature, max_tokens,
//                          ladder_timeout_ms, ladder_rung? }
//   response: 200 { choices:[{ message:{ content } }], model, usage }
//             non-2xx { error: { message, attempts? } }
//
// It NEVER talks to a model and NEVER needs a token of its own — the harness
// points the skill at it via LLM_LADDER_URL / LLM_LADDER_TOKEN.
//
// Behaviour is scripted: scripts/sandbox/fixtures.json maps a distinctive phrase
// found in the rendered prompt to an ordered list of responses. Response kinds:
//   { kind:'reply', content, model?, usage? }
//   { kind:'http_error', status, message }
// The Nth call for a matched scenario returns the Nth response (last one repeats).

import http from 'node:http';

const DEFAULT_MODEL = 'fake/gemini-2.5-flash';

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} o
 * @param {Array<{match:string, responses:Array<object>}>} o.scenarios scripted behaviours
 * @returns {Promise<{url:string, calls:Array<object>, close:()=>Promise<void>, reset:()=>void}>}
 */
export async function startFakeLadder({ scenarios = [] } = {}) {
  /** @type {Array<object>} every recorded ladder request (the anti-multiplication probe) */
  const calls = [];
  const perScenarioCount = new Map();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__calls') {
      return send(res, 200, { count: calls.length, calls });
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, scenarios: scenarios.length });
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      return send(res, 404, { error: { message: `fake-ladder: no route ${req.method} ${req.url}` } });
    }

    let body;
    try { body = await readBody(req); } catch (e) {
      return send(res, 400, { error: { message: `fake-ladder: bad json (${e.message})` } });
    }

    // Case-insensitive: the writer may capitalise the goal instruction it was handed.
    //
    // Three rules, each learned from a red sandbox:
    //  1. Match on the CALLER'S OWN messages only. The system prompt is the method's
    //     own instructions — it legitimately quotes example phrases («ты умеешь
    //     искать вакансии?»), and a fixture that matches such a phrase fires on every
    //     single request, turning a whole scenario block red for the wrong reason.
    //  2. A match that IS a bundle id is an exact key, not a substring: two scenarios
    //     may legitimately share the same user text and differ only in the catalog or
    //     the priority, and then the bundle id is the only honest discriminator.
    //  3. Otherwise the LONGEST match wins. «Сколько сделок в работе?» is a prefix of
    //     «…и открой обращение», and first-in-array order made the longer, more
    //     specific scripts unreachable.
    const callerText = (body.messages || [])
      .filter((m) => m && m.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n')
      .toLowerCase();
    const bundleKey = scenarios.find((s) => (
      /^b-[a-z0-9-]+$/i.test(String(s.match))
      && callerText.includes(`bundle: ${String(s.match).toLowerCase()} @`)
    ));
    const scenario = bundleKey || scenarios
      .filter((s) => callerText.includes(String(s.match).toLowerCase()))
      .sort((a, b) => String(b.match).length - String(a.match).length)[0];
    const key = scenario ? scenario.match : '(default)';
    const n = (perScenarioCount.get(key) || 0) + 1;
    perScenarioCount.set(key, n);

    calls.push({
      seq: calls.length + 1,
      scenario: key,
      ladder: body.model,
      rung: body.ladder_rung ?? null,
      temperature: body.temperature ?? null,
      max_tokens: body.max_tokens ?? null,
      // Recorded so a scenario can assert that the schema ACTUALLY went out. Without
      // it, dropping response_format would be invisible: the fake answers either way.
      response_format: body.response_format ?? null,
      app: req.headers['x-ladder-app'] ?? null,
      auth: /^Bearer\s+\S/.test(String(req.headers.authorization || '')) ? 'bearer' : 'MISSING',
      messages: body.messages || [],
    });

    if (!scenario) {
      return send(res, 500, { error: { message: `fake-ladder: no scripted scenario matched for ladder=${body.model}` } });
    }
    const list = scenario.responses || [];
    const step = list[Math.min(n, list.length) - 1];
    if (!step) return send(res, 500, { error: { message: `fake-ladder: empty script for ${key}` } });

    if (step.kind === 'http_error') {
      return send(res, step.status || 500, { error: { message: step.message || 'scripted upstream failure' } });
    }
    if (step.kind === 'hang') {
      return; // never answers — exercises the client-side timeout path
    }
    return send(res, 200, {
      id: 'fake-chatcmpl',
      model: step.model || DEFAULT_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: step.content || '' }, finish_reason: 'stop' }],
      usage: step.usage || { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955 },
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    reset() { calls.length = 0; perScenarioCount.clear(); },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}