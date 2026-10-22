// One rule for every MCP server name, whatever its source: drop-in folder,
// yaml entry, or controller-pushed roster (MULTI-PLATFORM-MCP §3.4).
//
// Server names are a routing key on the wire: an inbound name is split on its
// FIRST dot (dispatcher.ts), and under tunnel protocol 2.0 tool names become
// `<proxyId>.<server>.<tool>`, parsed id → server → tool. A dot inside a server
// name makes that parse ambiguous, so no source may produce one. Tool names
// may still contain dots: the tool is whatever remains after the server.
//
// Previously only the drop-in scanner enforced this; yaml and Type 2 names
// were unchecked.

// Alphanumeric start, then alphanumerics, dash or underscore. Covers every
// name we ship (agentic-memory, crm, salesforce, sample).
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

export const SERVER_NAME_RULE =
  "must start with a letter or digit and contain only letters, digits, '-' and '_' (no '.')";
