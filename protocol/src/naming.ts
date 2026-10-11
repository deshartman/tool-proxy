// Tool-name composition for protocol 2.x (decisions D1, D8, D11).
//
// Both sides import these; neither reimplements them. On the wire, server and
// tool names travel BARE inside descriptors. The qualified form
// `<shimId>.<server>.<tool>` is a rule both sides apply with these helpers.
//
// The parse is TWO-STEP, and the order is load-bearing:
//   1. split on the first "." → shimId
//   2. split the REMAINDER on its first "." → server
//   3. everything after that → tool (MAY contain further dots)
// "Split after the id" alone would read `k3f9x2qa.crm.get.customer` as server
// `crm.get`, tool `customer`. What makes the two-step parse unambiguous is that
// shimIds and server names are dot-free — enforced by the schemas below on
// every source a server name comes from.
//
// No author prefix (D11): author travels as ServerDescriptor metadata, never in
// the name.

import { z } from "zod";

// 8 lowercase Crockford base32 characters (40 bits). Crockford drops i l o u;
// lowercase keeps it stable under case-insensitive handling; every character is
// in OpenAI's tool-name alphabet. Must match the connector's identity/shim-id.ts.
export const SHIM_ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

// Alphanumeric start, then alphanumerics, dash or underscore — no dot. Must
// match the connector's identity/server-name.ts.
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export const shimIdSchema = z.string().regex(SHIM_ID_RE, "shimId must be 8 lowercase Crockford base32 characters");
export const serverNameSchema = z
  .string()
  .regex(SERVER_NAME_RE, "server name must start with a letter or digit and contain only letters, digits, '-' and '_' (no '.')");

export function isShimId(value: unknown): value is string {
  return typeof value === "string" && SHIM_ID_RE.test(value);
}

export function isServerName(value: unknown): value is string {
  return typeof value === "string" && SERVER_NAME_RE.test(value);
}

export interface QualifiedToolName {
  shimId: string;
  server: string;
  tool: string;
}

/**
 * Compose `<shimId>.<server>.<tool>`. Throws on a malformed shimId or server
 * name — composing one is a programmer error, and a malformed name would not
 * round-trip through parseQualifiedToolName.
 */
export function qualifyToolName(shimId: string, server: string, tool: string): string {
  if (!isShimId(shimId)) throw new Error(`qualifyToolName: invalid shimId ${JSON.stringify(shimId)}`);
  if (!isServerName(server)) throw new Error(`qualifyToolName: invalid server name ${JSON.stringify(server)}`);
  if (tool.length === 0) throw new Error("qualifyToolName: tool name is empty");
  return `${shimId}.${server}.${tool}`;
}

/**
 * Parse `<shimId>.<server>.<tool>` with the two-step rule. Returns undefined
 * for anything that is not a well-formed qualified name — never throws, because
 * the input comes off the wire.
 */
export function parseQualifiedToolName(name: string): QualifiedToolName | undefined {
  const first = name.indexOf(".");
  if (first <= 0) return undefined;
  const shimId = name.slice(0, first);
  const rest = name.slice(first + 1);
  const second = rest.indexOf(".");
  if (second <= 0) return undefined;
  const server = rest.slice(0, second);
  const tool = rest.slice(second + 1);
  if (tool.length === 0) return undefined;
  if (!isShimId(shimId) || !isServerName(server)) return undefined;
  return { shimId, server, tool };
}
