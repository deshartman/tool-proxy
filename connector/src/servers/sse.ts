import { Client, SSEClientTransport } from "@modelcontextprotocol/client";

// SSE outbound transport for 3rd-party MCPs (W-E5 of MCP-LOADING).
//
// The MCP SDK's SSEClientTransport pre-dates StreamableHTTPClientTransport;
// some upstream MCP servers in the wild still ship SSE-only. Header-based
// auth flows through `requestInit.headers` on the recurring POST requests
// the transport makes back to the upstream — same shape as
// servers/http.ts, just a different transport class.
//
// Note: SSEClientTransport is marked deprecated by the SDK in favor of
// streamable-http. We support it for backwards compat with upstream MCPs
// that haven't migrated yet. The connector itself ships only
// streamable-http for its own Type 1 MCPs.
import type { McpServerSpec } from "../config.js";
import { makeConnection, type McpServerConnection } from "./index.js";

export async function connectSse(spec: Extract<McpServerSpec, { transport: "http" }>): Promise<McpServerConnection> {
  if (!spec.endpoint) {
    throw new Error(`sse MCP server "${spec.name}" has no endpoint`);
  }
  // Auth headers from the supervisor's resolveSpecHeaders (W-E3 / W-E4).
  // The SDK's SSE transport routes these onto recurring POSTs; the initial
  // SSE handshake to the server is a GET that doesn't carry the same
  // headers (per the SDK doc: "Customizes recurring POST requests"),
  // which is fine for typical bearer/header auth schemes that scope to
  // the JSON-RPC POSTs only.
  const transportOpts = spec.headers
    ? { requestInit: { headers: spec.headers } }
    : undefined;
  const transport = new SSEClientTransport(new URL(spec.endpoint), transportOpts);
  // See servers/http.ts — 'auto' negotiates 2026-07-28 where available,
  // falls back to the 2025 handshake ("support both").
  const client = new Client(
    { name: "mcp-shim-connector", version: "0.1.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return makeConnection(spec.name, "http", client);
}
