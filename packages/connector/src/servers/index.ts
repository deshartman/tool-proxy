import type { McpServerSpec } from "../config.js";
import type { ToolDescriptor } from "../tunnel/frames.js";
import { connectHttp } from "./http.js";
import { connectStdio } from "./stdio.js";

// Raw tool from a local MCP server, before allow-list resolution.
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

export async function connectServer(spec: McpServerSpec): Promise<McpServerConnection> {
  if (spec.transport === "http") return connectHttp(spec);
  return connectStdio(spec);
}

export async function connectAll(specs: McpServerSpec[]): Promise<Map<string, McpServerConnection>> {
  const entries = await Promise.all(
    specs.map(async (s) => [s.name, await connectServer(s)] as const)
  );
  return new Map(entries);
}

// Helper: shape a DiscoveredTool into a ToolDescriptor with the allowed flag set.
export function toDescriptor(t: DiscoveredTool, allowed: boolean): ToolDescriptor {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    allowed,
  };
}
