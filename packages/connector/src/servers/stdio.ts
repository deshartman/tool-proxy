import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerSpec } from "../config.js";
import type { McpServerConnection } from "./index.js";
import { makeMcpConnection } from "./http.js";

export async function connectStdio(
  spec: Extract<McpServerSpec, { transport: "stdio" }>
): Promise<McpServerConnection> {
  const [command, ...args] = spec.command;
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "mcp-shim-connector", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return makeMcpConnection(spec.name, "stdio", client);
}
