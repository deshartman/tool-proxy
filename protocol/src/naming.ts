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

// ── Protocol 3.x (Tool Proxy rename) ────────────────────────────────────────
//
// 3.x renames the identity `shimId` → `proxyId` and composes tool names as
// `<proxyId>.<server>.<tool>`. The id RULE is unchanged (same 8 lowercase
// Crockford base32 characters), so a proxyId minted from an existing shimId
// value is valid, and the two-step parse above applies verbatim. The 2.x
// helpers and exports above stay frozen: a 3.x speaker still produces the
// exact 2.x wire for a peer that only advertises 2.x.
//
// Note a 2.x-qualified name and a 3.x-qualified name are syntactically
// identical (the id is the same shape); which one applies is decided by the
// NEGOTIATED major, never by inspecting the name.

export const PROXY_ID_RE = SHIM_ID_RE;

export const proxyIdSchema = z.string().regex(PROXY_ID_RE, "proxyId must be 8 lowercase Crockford base32 characters");

export function isProxyId(value: unknown): value is string {
  return typeof value === "string" && PROXY_ID_RE.test(value);
}

export interface QualifiedProxyToolName {
  proxyId: string;
  server: string;
  tool: string;
}

/** Compose `<proxyId>.<server>.<tool>`. Throws on a malformed proxyId or server name. */
export function qualifyProxyToolName(proxyId: string, server: string, tool: string): string {
  if (!isProxyId(proxyId)) throw new Error(`qualifyProxyToolName: invalid proxyId ${JSON.stringify(proxyId)}`);
  if (!isServerName(server)) throw new Error(`qualifyProxyToolName: invalid server name ${JSON.stringify(server)}`);
  if (tool.length === 0) throw new Error("qualifyProxyToolName: tool name is empty");
  return `${proxyId}.${server}.${tool}`;
}

/**
 * Parse `<proxyId>.<server>.<tool>` with the two-step rule. Returns undefined
 * for anything that is not well-formed (including a bare `<server>.<tool>`
 * name) — never throws, because the input comes off the wire.
 */
export function parseQualifiedProxyToolName(name: string): QualifiedProxyToolName | undefined {
  const parsed = parseQualifiedToolName(name);
  if (!parsed) return undefined;
  return { proxyId: parsed.shimId, server: parsed.server, tool: parsed.tool };
}
