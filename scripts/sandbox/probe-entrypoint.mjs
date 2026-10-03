'use strict';

// HARNESS PROBE ONLY — NOT the real MCP server.
//
// A minimal JSON-RPC stdio responder used by scripts/sandbox/harness.mjs to prove that
// the harness's own machinery (spawn + newline-delimited JSON-RPC + check runner) is
// alive BEFORE it is pointed at the real entrypoint. That way a red scenario is
// unambiguously "the feature is not implemented", not "the harness is broken".
//
// It deliberately implements NO tools: tools/list is empty and tools/call errors.

const TOOLS = [];
let initialized = false;

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) { write({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      initialized = true;
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sandbox-harness-probe', version: '0.0.0-probe' },
      });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call':
      return err(id, -32601, `probe: no tool ${params && params.name}`);
    default:
      if (id === undefined) return;
      return err(id, -32601, `probe: unknown method ${method}`);
  }
}

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
    try { msg = JSON.parse(line); } catch (e) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `probe: parse error ${e.message}` } });
      continue;
    }
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));