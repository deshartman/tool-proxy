import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import type { McpServerSpec } from "../config.js";
import { makeConnection, type McpServerConnection } from "./index.js";

// connectStdio is a thin transport adapter — it does NOT own the env merge.
// The supervisor builds the four-layer-merged env (process.env ⊕ spec.env ⊕
// sessionEnv ⊕ controllerEnv) once per spawn in startEntry and passes it in.
//
// Without `env`, falls back to spec.env merged on top of process.env — the
// legacy shape from before this change. Used only by non-supervisor callsites
// like discover.ts (boot-time `tools/list` survey). The supervisor ALWAYS
// passes env so controllerEnv + sessionEnv flow through; relying on the
// fallback inside the connector tunnel path would re-introduce the bug where
// stdio MCPs ignored controllerEnv.
//
// StdioClientTransport requires env values to be strings — we strip undefined
// from process.env at the boundary.
export async function connectStdio(
  spec: Extract<McpServerSpec, { transport: "stdio" }>,
  env?: Record<string, string>,
): Promise<McpServerConnection> {
  const [command, ...args] = spec.command;
  const resolvedEnv = env ?? legacyEnv(spec);
  const transport = new StdioClientTransport({ command, args, env: resolvedEnv });
  // 'auto' negotiates 2026-07-28 where available, else the 2025 handshake
  // ("support both"). NOTE: on stdio the SDK probes via a short-lived SIBLING
  // process (the command is spawned twice on connect). Fine for lightweight
  // servers; a heavy 2025-era bundle known never to speak 2026 could skip the
  // probe via client.connect(transport, { prior: { kind: "legacy" } }). Not
  // needed today — connect happens once per spawn, not per request.
  const client = new Client(
    { name: "mcp-shim-connector", version: "0.1.0" },
    // §9.3 — autoFulfill:false: no MCP fulfiller exists (no LLM, UI-only
    // controller). An `input_required` result surfaces as a typed error from
    // callTool → dispatcher relays `tool_failed`, not a maxRounds retry spin.
    { capabilities: {}, versionNegotiation: { mode: "auto" }, inputRequired: { autoFulfill: false } },
  );
  await client.connect(transport);
  return makeConnection(spec.name, "stdio", client);
}

function legacyEnv(spec: Extract<McpServerSpec, { transport: "stdio" }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (spec.env) Object.assign(env, spec.env);
  return env;
}
