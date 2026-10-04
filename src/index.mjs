'use strict';

// Cloudflare Worker entry: two doors, one handler (ADR-0001 extended).
//
// Why a Worker and not the VM: the GCP VM is being retired (agent#2053 cleanup,
// owner decision 03.10). A sibling stdio MCP server cannot outlive it — stdio
// means a local child process. So the method moves to a Worker and speaks
// HTTP: `POST /mcp` for MCP streamable-HTTP clients, `POST /v1/dialogs/next-message`
// as the plain REST face of the same application function (issue #6 §1).
//
// The ladder is ALREADY a Worker (trained-assist-llm-ladder), so the writer call
// stays Worker→Worker. No VM is involved in the request path at all, and we keep
// one model owner: still the shared ladder, no private keys here.
//
// Transport note: MCP streamable HTTP returns `text/event-stream` when the client
// advertises it in Accept, else plain JSON. We implement the JSON framing plus a
// one-event SSE fallback — enough for `initialize` / `tools/list` / `tools/call`,
// which is what a stateless worker-hosted MCP server is actually used for.

import { generateNextMessage, CONTRACT_VERSION, PROMPT_VERSION, MAX_ATTEMPTS } from './handler.mjs';
import { resolveUserIntent, INTENT_CONTRACT_VERSION, INTENT_PROMPT_VERSION } from './intent-handler.mjs';
import { extractConversationState, STATE_CONTRACT_VERSION, STATE_PROMPT_VERSION } from './state-handler.mjs';
import { evaluateNextGoal, GOAL_CONTRACT_VERSION } from './goal-handler.mjs';
import { TOOLS, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION, handleMcpMessage } from './mcp/protocol.mjs';
import { toolDeps } from './mcp/registry.mjs';

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function sse(payload, status = 200) {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

function wantsSse(request) {
  return String(request.headers.get('accept') || '').includes('text/event-stream');
}

/**
 * Auth: `Authorization: Bearer <COMMUNICATION_TOKEN>` (wrangler secret).
 * Health is public so a platform probe does not need the secret.
 * `status` is an HTTP status directly — this is the one place a misconfiguration
 * (no secret configured) must NOT be reported as 401, because "you are not
 * authorised" sends the caller hunting for a token that does not exist.
 */
function authorized(request, env) {
  const tokens = [env.COMMUNICATION_TOKEN, env.HH_COMMUNICATION_TOKEN].filter(Boolean);
  if (!tokens.length) return { ok: false, status: 500, code: 'NOT_CONFIGURED', message: 'COMMUNICATION_TOKEN не задан (wrangler secret put COMMUNICATION_TOKEN)' };
  const got = String(request.headers.get('authorization') || '');
  let matched = false;
  for (const token of tokens) {
    const expected = `Bearer ${token}`;
    let diff = got.length ^ expected.length;
    for (let i = 0; i < expected.length; i += 1) diff |= (got.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
    matched = matched || diff === 0;
  }
  return matched ? { ok: true } : { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' };
}

async function readJson(request) {
  try {
    return { ok: true, value: await request.json() };
  } catch (e) {
    return { ok: false, message: `bad json: ${e.message}` };
  }
}

function serveHealth(env) {
  // Report readiness honestly: a missing ladder config means this Worker cannot
  // write anything, and saying "ok" would be a lie a caller acts on.
  const configured = !!(env.LLM_LADDER_URL && env.LLM_LADDER_TOKEN);
  return json(configured ? 200 : 503, {
    status: configured ? 'ready' : 'not_configured',
    service: SERVER_NAME,
    version: SERVER_VERSION,
    contract_version: CONTRACT_VERSION,
    prompt_version: PROMPT_VERSION,
    ladder_configured: configured,
    capabilities: ['conversation-state-context-v1', 'free-goal-material-execution-v1'],
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return serveHealth(env);
    if (url.pathname === '/') {
      return json(200, { service: SERVER_NAME, contract_version: CONTRACT_VERSION, endpoints: ['/health', '/mcp', '/v1/dialogs/next-message', '/v1/conversations/state/extract', '/v1/conversations/next-goal', '/v1/intents/resolve'] });
    }

    const auth = authorized(request, env);
    if (!auth.ok) return json(auth.status, { error: { code: auth.code, message: auth.message } });

    // ── REST door ──────────────────────────────────────────────────────────
    if (url.pathname === '/v1/dialogs/next-message') {
      if (request.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'используй POST' } });
      const body = await readJson(request);
      if (!body.ok) return json(400, { error: { code: 'INVALID_INPUT', message: body.message, retryable: false } });
      const out = await generateNextMessage(body.value, env);
      // HTTP status mirrors the domain status so a plain REST caller does not have
      // to parse the body to know it failed — but the body always carries the full
      // contract, so MCP clients get the same information.
      const httpStatus = out.isError ? statusForCode(out.data?.error?.code) : 200;
      return json(httpStatus, out.data, { 'x-contract-version': CONTRACT_VERSION });
    }

    // ── REST door: extract_conversation_state (epic #11) ─────────────────────
    if (url.pathname === '/v1/conversations/state/extract') {
      if (request.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'используй POST' } });
      const body = await readJson(request);
      if (!body.ok) return json(400, { error: { code: 'INVALID_INPUT', message: body.message, retryable: false } });
      const out = await extractConversationState(body.value, env);
      if (out.isError) {
        return json(statusForCode(out.data?.error?.code), out.data, { 'x-contract-version': STATE_CONTRACT_VERSION });
      }
      return json(200, out.data, {
        'x-contract-version': STATE_CONTRACT_VERSION,
        'x-communication-request-id': out.meta?.request_id ?? null,
        'x-communication-diagnostics': JSON.stringify(out.meta ?? {}),
      });
    }

    if (url.pathname === '/v1/conversations/next-goal') {
      if (request.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'используй POST' } });
      const body = await readJson(request);
      if (!body.ok) return json(400, { error: { code: 'INVALID_INPUT', message: body.message, retryable: false } });
      const out = await evaluateNextGoal(body.value, env);
      if (out.isError) return json(statusForCode(out.data?.error?.code), out.data, { 'x-contract-version': GOAL_CONTRACT_VERSION });
      return json(200, out.data, { 'x-contract-version': GOAL_CONTRACT_VERSION, 'x-communication-request-id': out.meta?.request_id ?? null, 'x-communication-diagnostics': JSON.stringify(out.meta ?? {}) });
    }

    // ── REST door: resolve_user_intent (issue #10 §1) ─────────────────────────
    if (url.pathname === '/v1/intents/resolve') {
      if (request.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'используй POST' } });
      const body = await readJson(request);
      if (!body.ok) return json(400, { error: { code: 'INVALID_INPUT', message: body.message, retryable: false } });
      const out = await resolveUserIntent(body.value, env);
      if (out.isError) {
        return json(statusForCode(out.data?.error?.code), out.data, { 'x-contract-version': INTENT_CONTRACT_VERSION });
      }
      // The body is the two-field answer and nothing else. Diagnostics travel in
      // transport context (issue #10 §2): a REST caller compares the bundle version
      // it sent against the one echoed here, which is what makes a stale result
      // detectable instead of silently applied.
      return json(200, out.data, {
        'x-contract-version': INTENT_CONTRACT_VERSION,
        'x-communication-request-id': out.meta?.request_id ?? null,
        'x-communication-diagnostics': JSON.stringify(out.meta ?? {}),
      });
    }

    // ── MCP door ───────────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      if (request.method === 'GET') {
        // No server→client stream: this server never initiates messages. Clients
        // that opened one must be able to close it (405 is the spec'd answer).
        return json(405, { error: { code: 'NO_STREAM', message: 'сервер не инициирует сообщения' } });
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      if (request.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'используй POST' } });

      const body = await readJson(request);
      if (!body.ok) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: body.message } });

      const result = await handleMcpMessage(body.value, env, toolDeps({
        tools: TOOLS,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      }));
      // A notification (no id) gets no body per JSON-RPC.
      if (result === undefined) return new Response(null, { status: 202 });
      return wantsSse(request) ? sse(result) : json(200, result, { 'mcp-protocol-version': PROTOCOL_VERSION });
    }

    return json(404, { error: { code: 'NOT_FOUND', message: `нет маршрута ${url.pathname}` } });
  },
};

function statusForCode(code) {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'INPUT_TOO_LARGE':
      return 400;
    case 'MODEL_PROFILE_NOT_ALLOWED':
      return 400;
    case 'LLM_UNAVAILABLE':
      return 503;
    case 'GENERATION_REJECTED':
    case 'INTENT_REJECTED':
    case 'STATE_REJECTED':
    case 'GOAL_REJECTED':
      return 422;
    case 'MODEL_OUTPUT_INVALID':
      return 502;
    case 'TOO_MANY_DECISION_OPTIONS':
    case 'TOO_MANY_GOAL_OPTIONS':
      return 400;
    default:
      return 500;
  }
}
