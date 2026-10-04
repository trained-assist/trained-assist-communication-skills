# ADR-0002: State-first chain and goal evaluation

Status: Accepted · 2026-10-04 · Epic: #11

## Context

The writer currently receives history, facts, goal and style, then has to infer too much about what already happened in the dialog. This causes repeated questions, false promises, ignored refusals, and a larger prompt. Epic #11 changes the pipeline to:

```text
history -> conversation state -> next goal -> message
```

`resolve_user_intent` solves a separate problem: infer a user's goal and choose exactly one id from a caller-provided closed list. `evaluate_next_goal` has a different job: use a high-level conversation objective and extracted state to formulate an open-ended next communication goal.

## Decision

1. `extract_conversation_state` becomes the first MVP step of the new chain. It receives a full conversation history and a small, caller-provided `state_schema`; it returns JSON `state` that validates against the supported schema subset. No compression is introduced in MVP.
2. The supported `state_schema` is a deliberately small JSON Schema-like subset, validated server-side before the model call and again against the model output. Provider-side JSON schema is a request, not a guarantee.
3. Cheap or weak models are allowed only behind the shared ladder. The service never pins a concrete provider/model id for this epic. Invalid JSON or schema-invalid output gets one repair attempt, then a typed failure.
4. `evaluate_next_goal` takes `conversation_objective` and `conversation_state`, then generates a free-form `goal.instruction`; it does not receive or select from `goal_options`. Its control statuses are `goal_ready`, `wait`, and `no_matching_option`. An explicit contact ban is a deterministic `do_not_contact` terminal result.
5. `reason` may be missing or empty for an obvious next goal. `wait`, `no_matching_option`, and `do_not_contact` stop the chain before writer.
6. Freshness is explicit: each step echoes the input revision it evaluated. A caller must compare that revision before applying the result; stale results are not silently valid.

## Consequences

- The writer no longer has to rediscover dialog state from raw history.
- The first MVP is short and measurable: state extraction, then goal selection, then existing writer.
- `resolve_user_intent` remains the only closed-list resolver; next-goal evaluation generates an open instruction from objective and state.
- The state extractor can fail loudly on unsupported schemas or malformed model output instead of returning a plausible but unverifiable state.
