import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "../config.js";
import { makeConnection, type McpServerConnection } from "./index.js";

export async function connectHttp(spec: Extract<McpServerSpec, { transport: "http" }>): Promise<McpServerConnection> {
  if (!spec.endpoint) {
    // Should be unreachable: the spawner sets endpoint on Type 1 entries
    // before connectAll runs.
    throw new Error(`http MCP server "${spec.name}" has no endpoint and was not auto-spawned`);
  }
  const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint));
  const client = new Client({ name: "mcp-shim-connector", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return makeConnection(spec.name, "http", client);
}
