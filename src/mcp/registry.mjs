'use strict';

// The single place that says which tool name runs which application function.
//
// ADR-0001's invariant is «one handler per method, shared by every door». With two
// methods that invariant needs a registry: a tool name must resolve to the same
// function whether the request arrives over MCP HTTP, over stdio, or over REST.
// Before this file the mapping was implicit (`deps.generate`), which was correct
// while there was exactly one tool and silently wrong the day a second appeared.

import { generateNextMessage } from '../handler.mjs';
import { resolveUserIntent } from '../intent-handler.mjs';
import { extractConversationState } from '../state-handler.mjs';
import { evaluateNextGoal } from '../goal-handler.mjs';
import { composeNextMessage } from '../compose-handler.mjs';

export const TOOL_HANDLERS = Object.freeze({
  next_message_in_dialogue_from_goal: generateNextMessage,
  extract_conversation_state: extractConversationState,
  evaluate_next_goal: evaluateNextGoal,
  resolve_user_intent: resolveUserIntent,
  next_message_in_dialogue: composeNextMessage,
});

export function toolDeps({ serverName, serverVersion, protocolVersion, tools }) {
  return {
    tools,
    handlers: TOOL_HANDLERS,
    generate: TOOL_HANDLERS.next_message_in_dialogue_from_goal,
    serverName,
    serverVersion,
    protocolVersion,
  };
}
