// Transport dispatch — picks connectHttp / connectSse / connectWebSocket / connectStdio
// based on the spec. Lives in a separate module from index.ts so the
// type+helper barrel (index.ts) doesn't import from the transport files,
// which is what used to form the cycle.
//
// The wire format (McpConfigEntry.transport) carries five values:
// http / streamable-http / sse / websocket / stdio. The supervisor-side
// McpServerSpec only models two transports today (`http` and `stdio`) —
// the four HTTP-family wire variants all collapse to the `http`
// supervisor spec, with the SUB-transport carried via the internal
// `__transportKind` marker stamped by the controller-config coordinator
// (W-E5). Yaml entries leave it undefined and dispatch falls through to
// streamable-http (today's default for HTTP entries — Type 1 spawned
// children, Type 2 author-supplied http endpoints).

import type { McpServerSpec } from "../config.js";
import type { McpServerConnection } from "./index.js";
import { connectHttp } from "./http.js";
import { connectStdio } from "./stdio.js";
import { connectSse } from "./sse.js";
import { connectWebSocket } from "./websocket.js";

// Marker stamped by the controller-config coordinator on http-family roster
// entries. Distinguishes streamable-http (today's default) from sse and
// websocket. Internal field — not surfaced through yaml.
export type TransportKind = "streamable-http" | "sse" | "websocket";

// `env` is the supervisor-merged env (process.env ⊕ spec.env ⊕ sessionEnv ⊕
// controllerEnv) — built ONCE in startEntry so every transport sees the same
// four-layer precedence model. Only the stdio branch reads it; HTTP-family
// transports use `spec.headers` (the auth resolver's output) for credentials
// since the upstream process isn't ours to spawn.
//
// Optional for backward compat with two callers we don't want to thread env
// through: discover.ts (boot-time `tools/list` survey, runs once with whatever
// env was in place at spec construction) and any future caller that already
// has the env pre-baked into spec.env. When env is omitted, the stdio path
// falls back to spec.env — the legacy shape, fine for yaml entries with
// dir/.env but the load-bearing call site (supervisor.startEntry) ALWAYS
// passes env so controllerEnv/sessionEnv flow through.
export async function connectServer(
  spec: McpServerSpec,
  env?: Record<string, string>,
): Promise<McpServerConnection> {
  if (spec.transport === "stdio") return connectStdio(spec, env);
  const kind = (spec as { __transportKind?: TransportKind }).__transportKind;
  if (kind === "sse") return connectSse(spec);
  if (kind === "websocket") return connectWebSocket(spec);
  return connectHttp(spec);
}

export async function connectAll(specs: McpServerSpec[]): Promise<Map<string, McpServerConnection>> {
  const entries = await Promise.all(
    specs.map(async (spec) => [spec.name, await connectServer(spec)] as const),
  );
  return new Map(entries);
}
