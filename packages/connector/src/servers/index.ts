// Connection-shape types + the makeConnection helper. This module exists
// independently of connectHttp / connectStdio (which live in their own
// transport files and dispatch through ./connect.js) so the cycle that used
// to exist — index.ts ↔ http.ts ↔ stdio.ts — is gone:
//
//   * http.ts and stdio.ts import only from index.ts (types + makeConnection)
//   * index.ts imports nothing from the transport files
//   * connect.ts imports from both transport files; consumers call into
//     connect.ts (not index.ts) for connectServer / connectAll
//
// `npx madge --circular packages/connector/src` reports zero cycles after
// this split.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDescriptor } from "../tunnel/frames.js";

// Raw tool from a local MCP server, before being shaped into a ToolDescriptor.
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface McpServerConnection {
  name: string;
  transport: "http" | "stdio";
  listTools(): Promise<DiscoveredTool[]>;
  callTool(name: string, args: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  close(): Promise<void>;
}

// Wrap a connected SDK Client in the McpServerConnection shape the rest of
// the connector consumes. Lives here (alongside the type it implements)
// rather than in http.ts so stdio.ts can import it without forming a cycle.
export function makeConnection(
  name: string,
  transport: "http" | "stdio",
  client: Client,
): McpServerConnection {
  return {
    name,
    transport,
    async listTools(): Promise<DiscoveredTool[]> {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }));
    },
    async callTool(toolName, args, opts) {
      return client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> | undefined },
        undefined,
        { timeout: opts.timeoutMs },
      );
    },
    async close() {
      await client.close();
    },
  };
}

// Helper: shape a DiscoveredTool into a ToolDescriptor with the allowed flag set.
export function toDescriptor(tool: DiscoveredTool, allowed: boolean): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    allowed,
  };
}
