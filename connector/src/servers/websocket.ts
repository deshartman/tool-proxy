// WebSocket outbound transport for 3rd-party MCPs (W-E5 of MCP-LOADING).
//
// "WebSocket transport" here means the connector dials a separate WS to the
// upstream MCP server's URL (e.g. wss://upstream.example.com/mcp). This is
// COMPLETELY INDEPENDENT from the connector ↔ controller `/mcp-tunnel` WS
// — different socket, different auth, different lifecycle.
//
// SDK note: WebSocketClientTransport accepts only a URL — it has no
// requestInit / headers API for the WS handshake. Auth on a WebSocket MCP
// must therefore be embedded in the URL (token query param, basic-auth in
// the URL userinfo, etc.) by the operator at row-creation time on the
// controller. If a WebSocket entry arrives with non-empty spec.headers
// (resolved from a bearer / header / OAuth2 auth shape), we log a warn —
// those headers cannot be attached and the upstream will likely 401.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { McpServerSpec } from "../config.js";
import { makeConnection, type McpServerConnection } from "./index.js";
import { createLogger } from "../logger.js";

const log = createLogger("websocket-client");

export async function connectWebSocket(spec: Extract<McpServerSpec, { transport: "http" }>): Promise<McpServerConnection> {
  if (!spec.endpoint) {
    throw new Error(`websocket MCP server "${spec.name}" has no endpoint`);
  }
  if (spec.headers && Object.keys(spec.headers).length > 0) {
    log.warn(
      { name: spec.name, headerNames: Object.keys(spec.headers) },
      `WebSocket transport does not support custom headers — embed auth in the URL (token query param) instead. Headers will be dropped.`,
    );
  }
  const transport = new WebSocketClientTransport(new URL(spec.endpoint));
  const client = new Client({ name: "mcp-shim-connector", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return makeConnection(spec.name, "http", client);
}
