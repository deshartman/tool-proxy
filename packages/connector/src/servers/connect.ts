// Transport dispatch — picks connectHttp or connectStdio based on the spec.
// Lives in a separate module from index.ts so the type+helper barrel
// (index.ts) doesn't import from the transport files, which is what used to
// form the cycle.

import type { McpServerSpec } from "../config.js";
import type { McpServerConnection } from "./index.js";
import { connectHttp } from "./http.js";
import { connectStdio } from "./stdio.js";

export async function connectServer(spec: McpServerSpec): Promise<McpServerConnection> {
  if (spec.transport === "http") return connectHttp(spec);
  return connectStdio(spec);
}

export async function connectAll(specs: McpServerSpec[]): Promise<Map<string, McpServerConnection>> {
  const entries = await Promise.all(
    specs.map(async (s) => [s.name, await connectServer(s)] as const),
  );
  return new Map(entries);
}
