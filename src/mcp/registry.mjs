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

export const TOOL_HANDLERS = Object.freeze({
  generate_next_message_to_conversation_partner: generateNextMessage,
  resolve_user_intent: resolveUserIntent,
});

export function toolDeps({ serverName, serverVersion, protocolVersion, tools }) {
  return {
    tools,
    handlers: TOOL_HANDLERS,
    generate: TOOL_HANDLERS.generate_next_message_to_conversation_partner,
    serverName,
    serverVersion,
    protocolVersion,
  };
}
