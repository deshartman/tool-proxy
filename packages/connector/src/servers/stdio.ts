import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerSpec } from "../config.js";
import type { McpServerConnection } from "./index.js";
import { makeMcpConnection } from "./http.js";

export async function connectStdio(
  spec: Extract<McpServerSpec, { transport: "stdio" }>
): Promise<McpServerConnection> {
  const [command, ...args] = spec.command;
  // Layer the entry's per-folder .env (loaded by config.ts) on top of
  // process.env so each stdio child only sees its own creds + the shared
  // tunnel env. StdioClientTransport requires `env` values be strings.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (spec.env) Object.assign(env, spec.env);
  const transport = new StdioClientTransport({ command, args, env });
  const client = new Client({ name: "mcp-shim-connector", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return makeMcpConnection(spec.name, "stdio", client);
}
