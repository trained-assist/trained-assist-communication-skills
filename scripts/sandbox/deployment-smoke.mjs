const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('sandbox_source_invalid');
const base = 'https://trained-assist-communication-v1-sandbox.skillset-apply.workers.dev';
let health;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const body = await response.json();
    if (response.status === 200 && body.build === sha && body.ladder_configured === true) { health = body; break; }
  } catch { /* bounded edge propagation check, no model calls */ }
  if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!health) throw new Error('sandbox_health_source_unverified');
let status;
try {
  const response = await fetch(base + '/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10000), redirect: 'error' });
  status = response.status;
  await response.body?.cancel();
} catch { throw new Error('sandbox_anonymous_probe_unavailable'); }
if (status !== 401) throw new Error('sandbox_anonymous_probe_not_rejected');
console.log(JSON.stringify({ outcome: 'passed', buildSha: sha, anonymousMcpStatus: status,
  canonicalLadderEndpoint: health.canonical_ladder_endpoint === true, modelCalled: false }));
