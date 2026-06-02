import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "../config.js";
import type { DiscoveredTool, McpServerConnection } from "./index.js";

export async function connectHttp(spec: Extract<McpServerSpec, { transport: "http" }>): Promise<McpServerConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint));
  const client = new Client({ name: "mcp-shim-connector", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return makeConnection(spec.name, "http", client);
}

function makeConnection(
  name: string,
  transport: "http" | "stdio",
  client: Client
): McpServerConnection {
  return {
    name,
    transport,
    async listTools(): Promise<DiscoveredTool[]> {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      }));
    },
    async callTool(toolName, args, opts) {
      return client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> | undefined },
        undefined,
        { timeout: opts.timeoutMs }
      );
    },
    async close() {
      await client.close();
    },
  };
}

export { makeConnection as makeMcpConnection };
