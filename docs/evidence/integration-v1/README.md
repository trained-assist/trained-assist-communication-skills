# Integration v1 — live communication sandbox evidence

Date: 2026-10-05
Branch: `integration/v1-sandbox-20261005`
PR: https://github.com/trained-assist/trained-assist-communication-skills/pull/18 (draft)
Integration issue: https://github.com/trained-assist/trained-agent-architecture/issues/140
Target Worker: `trained-assist-communication-v1-sandbox` (own caller token, separate from any existing deployment)

## Scope

Validates the communication MCP surface the integrator pokes from its Telegram entry:
transport auth, MCP discovery shape, and `resolve_user_intent` routing for the catalog the
integrator actually passes. It does not exercise the Telegram ingress, the control plane, or an
agent run — those are separate worktrees.

## What was wrong and what changed

Live smoke before the change: `health-question` ("Работает?") and `health-paraphrase` ("Ты сейчас
на связи и можешь отвечать?") both returned `no_matching_option` instead of `system_health`.
Capabilities, paraphrase and the compound task were already correct.

Root cause is in the caller-supplied catalog, not in the resolver:

- `recipient.role` was `Помощник trained-assist`, which does not make clear that a question about
  being "on line" is a question about the assistant/system itself.
- `system_health.applicability` only said "вопрос о работоспособности". The resolver prompt treats
  a system-state question without `runtime_facts` as having no basis for any option, so the model
  honestly refused. The option never said that selecting it only *routes* the request to a real
  probe executed after classification.

Fix, in `scripts/integration/v1-smoke.mjs` only:

- `recipient` now states the assistant/system scope explicitly (`role` + `scope`).
- `system_health.applicability` now says the choice only directs the request to a real state probe
  run **after** classification, that the classifier neither needs to know nor to assert the actual
  state, and that it does not apply when the user also asks for another task.
- `agent.applicability` already excludes pure health/capabilities questions; kept.

No phrase matching, no separate classifier, no invented `runtime_facts`, no change to the model
configuration. The resolver still runs on the shared `service:classify` ladder profile.

## Cases

| Case | Input | Expected |
|---|---|---|
| `health-question` | Работает? | `system_health` |
| `health-paraphrase` | Ты сейчас на связи и можешь отвечать? | `system_health` |
| `capabilities-question` | Что ты умеешь? | `catalog.brief` |
| `capabilities-paraphrase` | Какие у тебя функции и что можно подключить? | `catalog.brief` |
| `compound-task` | Работает? Тогда прочитай таблицу расходов, найди дубли и создай отдельный лист с итогами. | `agent` |
| `compound-with-health` | Переведи этот файл и проверь, работает ли сервис | `agent` |
| `unknown-request` | Удали мою подписку | `no_matching_option` |

Plus three transport checks: `GET /health` → `ready`, unsigned `POST /mcp` → 401, and
`tools/list` exposing all four methods with `resolve_user_intent.outputSchema.properties.decision`
published as a nonempty string with no `enum`.

## Two runs

Reports: `smoke-run-1.json`, `smoke-run-2.json`. Sanitized — no tokens, no URLs, no host addresses.

| Scenario | Run 1 | Run 2 |
|---|---|---|
| health | pass | pass |
| unauthorized-mcp | pass | pass |
| tools-list | pass | pass |
| health-question | pass `system_health` | pass `system_health` |
| health-paraphrase | pass `system_health` | pass `system_health` |
| capabilities-question | pass `catalog.brief` | pass `catalog.brief` |
| capabilities-paraphrase | pass `catalog.brief` | pass `catalog.brief` |
| compound-task | pass `agent` | pass `agent` |
| compound-with-health | pass `agent` | pass `agent` |
| unknown-request | pass `no_matching_option` | **fail → `agent`** |
| **total** | **10/10** | **9/10** |

### The one failure, as observed

`unknown-request` ("Удали мою подписку") returned `agent` in run 2 and `no_matching_option` in
run 1. This is the classifier confusion the resolver prompt itself warns about — an unsupported
action ("удалить", "вернуть", "остановить") is not the same as a task an agent may run, and the
prompt names this exact case. It is a semantic limitation of the model on the closed-list boundary,
not an integration defect: the transport, auth, discovery schema and two-field contract all
behaved correctly on the same request.

A separate probe of unsupported-action phrasings (two calls each, same catalog) reproduced the same
instability: "Верни деньги за прошлый месяц" → `agent` then `no_matching_option`; "Удали мою
подписку" → `no_matching_option` twice here but `agent` in the full smoke run 2. The boundary is
genuinely nondeterministic at this catalog size. Not fixed here — tuning the catalog further to
make this case green would be hiding a real classifier limitation, and the corpus (`corpus:live`)
is the right place to measure it.

## Provider outcomes

All resolver calls in both runs: model `opencode-go/space-bunny-free`, `attempts: 1`, zero warnings.
Input tokens 2031–2060, output tokens 24–240. Ladder latency 1270–7795 ms; end-to-end scenario
latency 1289–7839 ms. No guard repairs, no `INTENT_REJECTED`, no `LLM_UNAVAILABLE`.

## Local validation

- `npm run gate` — check, 223 unit tests, sandbox 35/35.
- Focused schema + Worker tests: 50/50.
- Independent review of the MCP discovery fix (`src/intent-schema.mjs:68`): the static
  `tools/list` schema publishes `decision` as `string`/`minLength: 1` with no `enum`, while the
  per-request schema sent to the model (`buildDecisionOutputSchema`, `src/intent-schema.mjs:46`)
  still carries the caller's closed enum plus `no_matching_option`, and `validateIntentOutput`
  re-checks the answer against that enum regardless of provider behaviour. Wiring confirmed at
  `src/mcp/protocol.mjs:188` and `src/intent-handler.mjs:433`.

## Reproduce

```bash
npm run gate
INTEGRATION_BINDINGS_FILE=/path/to/private/client-bindings.json \
INTEGRATION_REPORT_FILE=docs/evidence/integration-v1/smoke-run-N.json \
  node scripts/integration/v1-smoke.mjs
```

Bindings require `COMMUNICATION_API_URL` and `COMMUNICATION_TOKEN`. The private bindings file is
never committed.

## Remaining limitations

- The unsupported-action boundary is nondeterministic (see above). Measuring it needs `corpus:live`
  against the shared ladder, which needs its own secrets.
- The smoke covers the communication MCP only. Telegram ingress, control-plane routing, agent
  execution and delivery are validated in other worktrees.
- Two runs is a stability sample, not a guarantee; the ladder has known intermittent 502s that a
  short sample will not surface.
