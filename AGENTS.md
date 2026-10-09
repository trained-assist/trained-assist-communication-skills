# Communication environment contract

Read README.md for method contracts and the shared ladder boundary. Use separate
worktrees/branches; preserve other sessions and open PRs. Do not call retiring GCP
services. Never print tokens, prompts, model replies or raw dependency errors in
public evidence.

## Local and sandbox

`npm ci && npm run gate` verifies handlers and the HTTP/MCP fake-ladder sandbox.
These runs call no real model. The stateless `trained-assist-communication-v1-sandbox`
Worker is declared by `wrangler.integration-v1.jsonc`; it has its own caller token
and reuses the approved shared ladder. The owner-authorized architecture issue
#236 permits reviewed main deployment through `deploy-integration-sandbox.yml`.
Verify Cloudflare account `d740a05e9442c1d0feacae2dfc673e93` before Wrangler.
Preserve its three existing secret bindings. Observe exact BUILD_SHA, anonymous
MCP rejection and sanitized intent timing logs; shared ladder trace IDs correlate
attempts. Model probes must be bounded, use synthetic input and the approved
profile; no provider keys or independent fallback chain. The fixed
`POST /internal/sandbox/intent-probe` accepts only a UUID and its separate
`SANDBOX_PROBE_TOKEN`, enabled only in this sandbox. That token cannot call normal
MCP methods. Provision it via stdin only after confirming the binding is absent;
preserve it on retries. One probe uses a fixed short synthetic query, at most two
shared-ladder attempts within 120s, and returns only sanitized timing/outcomes.
Never automatically repeat an unknown model probe; reconcile trace logs first.
The service is stateless,
so retries require a fresh probe ID and no database reset. Public health metadata
does not prove a model call or answer quality.

## Production promotion

`.github/workflows/deploy.yml` gates main deployment to the separate public
`trained-assist-communication-skills` Worker with `npm run gate` and a bundle
check, then verifies its public BUILD_SHA. Use that path for production changes;
do not deploy the sandbox config over production or rotate shared credentials.
