# evaluate_next_goal — contract (epic #11)

## Purpose

Formulate the next useful communication move from the high-level conversation objective and extracted conversation state:

```text
objective + state -> open-ended next goal or terminal outcome
```

This is not a selection from a caller-provided goal list. For example, if the objective is to qualify CRM experience and the state shows that experience is still unknown, the method may return a writer goal such as “уточнить, с какими CRM кандидат работал и какие задачи в них выполнял”.

## Input

Required fields:

- `conversation_objective`: the broader outcome the conversation should advance.
- `conversation_state`: structured result from `extract_conversation_state`.
- `conversation_revision`: revision of the history used to produce that state.

Optional `language` controls the language of the goal instruction. The total serialized objective and state are limited to 120,000 characters.

## Output

```json
{
  "status": "goal_ready",
  "requires_message": true,
  "goal": {
    "instruction": "Уточнить, с какими CRM кандидат работал и какие задачи в них выполнял",
    "required_points": [],
    "forbidden_points": []
  },
  "reason": "",
  "request_id": "r-123",
  "conversation_revision": "history-v7"
}
```

`goal.instruction` is generated from the objective and state; it is not copied from a fixed goal catalog. `reason` may be omitted or empty. The `status` values are control outcomes, not goal choices:

| Status | Writer behavior |
|---|---|
| `goal_ready` | Call writer with `goal`; `requires_message:true`. |
| `wait` | Stop; do not call writer. |
| `no_matching_option` | Stop because no grounded next move can be formulated. |
| `do_not_contact` | Deterministic server result when state explicitly contains a contact ban; model is not called. |

The consumer must compare the echoed `conversation_revision` with the current history before applying the result and discard it if a newer message has arrived.

## Model and validation

The shared ladder profile comes from `LLM_LADDER_NAME` (default `service:classify`); no concrete model is pinned. The server validates status, requires a non-empty goal instruction for `goal_ready`, rejects goals on terminal model statuses, and allows only the supported goal fields. Invalid output is retried once, then returns `GOAL_REJECTED`.

## REST and MCP

```text
POST /v1/conversations/next-goal
POST /mcp tools/call evaluate_next_goal
```

Errors: `VALIDATION_ERROR` (400), `INPUT_TOO_LARGE` (400), `MODEL_PROFILE_NOT_ALLOWED` (400), `LLM_UNAVAILABLE` (503), `GOAL_REJECTED` (422).

## Optional verbatim-material execution (#HH142 S0)

Caller may supply `material_bindings:[{stage_id:"stable-id"}]`. This is a set of saved material references, not a closed goal catalog. The goal remains freely formulated. For an actual saved-material delivery, the result additionally contains `execution:{type:"send_material",stage_id:"stable-id"}`; the server validates that the ID was provided. Other messages have null/write_message execution; terminal statuses have null execution. HH resolves the exact text and snapshot, guards duplicate/unknown outcomes, and does not invoke writer for send_material. With no material_bindings the old response shape is preserved. No separate consent requirement is added by this contract.
