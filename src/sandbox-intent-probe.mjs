import { resolveUserIntent } from './intent-handler.mjs';

const reply = (status, body) => Response.json(body, { status });
export async function sandboxIntentProbe(request, env) {
  if (env.DEPLOYMENT_ENV !== 'sandbox' || env.SANDBOX_INTENT_PROBE_ENABLED !== 'true' || request.method !== 'POST') {
    return reply(404, { code: 'probe_unavailable' });
  }
  const token = env.SANDBOX_PROBE_TOKEN;
  if (typeof token !== 'string' || token.length < 32) return reply(503, { code: 'probe_not_configured' });
  const expected = `Bearer ${token}`, supplied = request.headers.get('authorization') ?? '';
  let diff = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
  if (diff) return reply(401, { code: 'unauthorized' });
  let body;
  try { body = await request.json(); } catch { return reply(400, { code: 'invalid_probe_request' }); }
  if (!body || Object.keys(body).length !== 1 || typeof body.requestId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.requestId)) {
    return reply(400, { code: 'invalid_probe_request' });
  }
  const started = Date.now();
  const result = await resolveUserIntent({ request_id: body.requestId, trace_id: body.requestId,
    input_bundle: { id: body.requestId, events: [{ id: 'synthetic-event', type: 'text', author: 'user', text: 'Работает ли помощник?' }] },
    recipient: { role: 'Помощник trained-assist' },
    decision_options: [{ id: 'system_health', description: 'Проверить доступность самого помощника после выбора маршрута, затем сообщить проверенные факты.' },
      { id: 'agent', description: 'Выполнить другую пользовательскую задачу, требующую действий или инструментов.' }],
  }, env);
  const code = result.isError ? ['LLM_UNAVAILABLE', 'INTENT_REJECTED'].includes(result.data?.error?.code)
    ? result.data.error.code : 'probe_failed' : 'resolved';
  const decision = result.isError ? null : result.data?.decision;
  const success = !result.isError && decision === 'system_health';
  return reply(success ? 200 : 502, { ok: success, code, requestId: body.requestId, buildSha: env.BUILD_SHA ?? null,
    elapsedMs: Date.now() - started, decision: ['system_health', 'agent', 'no_matching_option'].includes(decision) ? decision : null,
    attempts: result.meta?.generation?.attempts ?? result.data?.error?.attempts ?? null,
    sideEffects: { modelMayHaveBeenCalled: true, agentStarted: false, messageSent: false, cpTaskCreated: false },
  });
}
