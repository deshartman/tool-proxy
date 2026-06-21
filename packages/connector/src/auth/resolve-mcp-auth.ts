// Resolve a 3rd-party MCP's auth shape (McpAuthSpec) + the env values the
// controller has supplied for this MCP into outbound HTTP headers.
//
// W-E3 of MCP-LOADING. Called by the supervisor right before it connects an
// HTTP-family 3rd-party MCP, so the headers reflect the freshest env (a
// creds-update → restart will re-resolve naturally — same code path as the
// initial spawn).
//
// Stdio entries do not call this — env values flow into the child process's
// environment directly via the existing per-spec env map.
//
// OAuth2 client_credentials is handled in resolve-mcp-auth-async.ts (W-E4)
// because it has to mint a JWT against a token URL. This module is the
// synchronous portion (none / bearer / header) and is the right entrypoint
// for the non-OAuth shapes; the async helper composes with this one.

import type { McpAuthSpec } from "../tunnel/frames.js";

export type ResolvedAuthHeaders = Record<string, string>;

export interface AuthResolveResult {
  headers: ResolvedAuthHeaders;
  // Env keys the resolver expected but did not find in `env`. Used by the
  // caller to log a per-MCP warn (the upstream call will fail; the operator
  // needs to know which key the controller hasn't populated yet).
  missingEnvKeys: string[];
}

// Sync resolver for the non-OAuth shapes. Returns headers + a list of
// env keys that were declared but absent — caller decides whether to spawn
// anyway (we do — the upstream's 401 surfaces in the inspector and is the
// fastest signal that creds haven't been entered yet).
export function resolveAuthHeaders(
  auth: McpAuthSpec,
  env: Record<string, string>,
): AuthResolveResult {
  const missingEnvKeys: string[] = [];
  if (auth.kind === "none") {
    return { headers: {}, missingEnvKeys };
  }
  if (auth.kind === "bearer") {
    const value = env[auth.envKey];
    if (!value) {
      missingEnvKeys.push(auth.envKey);
      return { headers: {}, missingEnvKeys };
    }
    return { headers: { Authorization: `Bearer ${value}` }, missingEnvKeys };
  }
  if (auth.kind === "header") {
    const value = env[auth.envKey];
    if (!value) {
      missingEnvKeys.push(auth.envKey);
      return { headers: {}, missingEnvKeys };
    }
    return { headers: { [auth.headerName]: value }, missingEnvKeys };
  }
  // OAuth2 — sync resolver returns no headers; the async resolver
  // (resolve-mcp-auth-async.ts) handles this branch by minting a JWT.
  return { headers: {}, missingEnvKeys };
}

// True when the auth shape is one this sync resolver fully handles. False
// for OAuth2, which the supervisor must resolve via the async helper.
export function isSyncResolvable(auth: McpAuthSpec): boolean {
  return auth.kind === "none" || auth.kind === "bearer" || auth.kind === "header";
}
