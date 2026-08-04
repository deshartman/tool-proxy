import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpServerSpec } from "../config.js";
import { makeConnection, type McpServerConnection } from "./index.js";

export async function connectHttp(spec: Extract<McpServerSpec, { transport: "http" }>): Promise<McpServerConnection> {
  if (!spec.endpoint) {
    // Should be unreachable: the spawner sets endpoint on Type 1 entries
    // before connectAll runs.
    throw new Error(`http MCP server "${spec.name}" has no endpoint and was not auto-spawned`);
  }
  // spec.headers is set by the controller-config coordinator (W-E3) when a
  // 3rd-party MCP declares an auth shape — Bearer / custom-header / OAuth2.
  // Type 1 / Type 2 yaml entries leave it undefined and the transport runs
  // unauthenticated as today.
  const transportOpts = spec.headers
    ? { requestInit: { headers: spec.headers } }
    : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint), transportOpts);
  // versionNegotiation 'auto' probes server/discover and speaks 2026-07-28
  // when the upstream supports it, falling back to the 2025 initialize
  // handshake otherwise ("support both"). The probe is a cheap HTTP request.
  const client = new Client(
    { name: "mcp-shim-connector", version: "0.1.0" },
    // §9.3 — autoFulfill:false: there is no MCP fulfiller in this system (no
    // LLM, UI-only controller). An `input_required` result then surfaces as a
    // typed error from callTool → the dispatcher relays it as `tool_failed`,
    // rather than the default spinning maxRounds retries against absent handlers.
    { capabilities: {}, versionNegotiation: { mode: "auto" }, inputRequired: { autoFulfill: false } },
  );
  await client.connect(transport);
  return makeConnection(spec.name, "http", client);
}
