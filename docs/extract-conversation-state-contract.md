# extract_conversation_state — contract (epic #11)

## Purpose

Extract a structured state object from the full conversation history:

```text
history -> state
```

The method does not choose the next goal, does not write a message, and does not send anything. Its output is an input for `evaluate_next_goal`.

## REST and MCP

```text
POST /v1/conversations/state/extract -> { state, request_id, conversation_revision, generation, usage, timing, input_metrics, warnings }
POST /mcp tools/call extract_conversation_state -> same structuredContent
```

## Required input

```json
{
  "request_id": "r-123",
  "trace_id": "trace-123",
  "conversation_revision": "history-v7",
  "conversation_history": {
    "format": "messages",
    "messages": [
      {"id": "m1", "speaker": "sender", "text": "Подскажите опыт с Python?"},
      {"id": "m2", "speaker": "partner", "text": "Да, 5 лет. Но переезд не рассматриваю."}
    ]
  },
  "state_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["answered_questions", "constraints"],
    "properties": {
      "answered_questions": {
        "type": "array",
        "items": {"type": "string"},
        "maxItems": 20
      },
      "constraints": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["quote", "source_message_id"],
          "properties": {
            "quote": {"type": "string", "maxLength": 400},
            "source_message_id": {"type": "string"}
          }
        },
        "maxItems": 20
      }
    }
  },
  "options": {"language": "ru"},
  "model_profile": "default"
}
```

## Supported schema subset

Root must be an object schema. Supported keywords:

`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `minimum`, `maximum`, `description`.

Supported scalar types: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`.

Unsupported keywords fail before the model call. `additionalProperties` may be omitted or `false`; arbitrary extra output fields are not accepted.

## Freshness

`conversation_revision` is echoed in the response. If the caller receives a newer message while the extraction is running, it must discard the result instead of applying state from an older revision.

## Errors

Technical failures are typed errors, not successful empty state:

| Code | HTTP | When |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | malformed input or unsupported `state_schema` |
| `INPUT_TOO_LARGE` | 400 | input exceeds MVP size budget |
| `MODEL_PROFILE_NOT_ALLOWED` | 400 | unknown server profile |
| `LLM_UNAVAILABLE` | 503 | shared ladder unavailable |
| `STATE_REJECTED` | 422 | model output invalid after retry |
| `MODEL_OUTPUT_INVALID` | 502 | response could not be parsed as JSON |

## Optional full profile/context inputs (#HH142 S0)

`extraction_instructions` is a string. `partner_profile`, `sender_profile`, `context` and `communication_plan` may be strings or objects. They are passed in full and counted in the same explicit size budget; excess returns INPUT_TOO_LARGE. Profile facts must not be converted into conversational promises; plan milestones must not be treated as already achieved.

Optional `evidence_source_refs` maps source IDs to JSON pointers into the supplied input, for example `{ "profile": "/partner_profile", "context": "/context/factual_context" }`. No source text is duplicated. When this metadata is present, message IDs also identify their original message text. Recursive `evidence[]` entries with `source_id` must have a nonempty `quote` found exactly in the referenced source, including original whitespace. Failed provenance uses the existing state validation repair loop (at most two attempts sharing the fixed 60-second deadline), then returns `STATE_REJECTED`. Diagnostics identify the evidence path, never the rejected quote or model-generated source ID. Without this metadata, existing generic schema behavior is unchanged.
