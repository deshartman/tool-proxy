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

export async function connectServer(spec: McpServerSpec): Promise<McpServerConnection> {
  if (spec.transport === "stdio") return connectStdio(spec);
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
