'use strict';

// stdio MCP door (ADR-0001). Kept because the local sandbox and `node --test`
// speak stdio JSON-RPC with no HTTP stack — but it is now a THIN wrapper: the
// entire conversation lives in src/mcp/protocol.mjs, shared verbatim with the
// Cloudflare Worker door (src/index.mjs). Logic added here would be a second
// implementation, which is exactly what ADR-0001 forbids.

import { TOOLS, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION, handleMcpMessage } from './protocol.mjs';
import { toolDeps } from './registry.mjs';

const deps = toolDeps({
  tools: TOOLS,
  serverName: SERVER_NAME,
  serverVersion: SERVER_VERSION,
  protocolVersion: PROTOCOL_VERSION,
});

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// process.env, not a captured copy: the sandbox sets the ladder vars in the
// child's environment before spawn.
const env = process.env;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `${SERVER_NAME}: parse error ${e.message}` } });
      continue;
    }
    const run = (m) => handleMcpMessage(m, env, deps)
      .then((res) => { if (res !== undefined) write(res); })
      .catch((e) => {
        if (m && m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `${SERVER_NAME}: ${e.message}` } });
      });
    if (Array.isArray(msg)) msg.forEach(run);
    else run(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
