// Per-workspace storage on the state volume (MULTI-PLATFORM-MCP §5.3, D15).
//
//   ${CONNECTOR_STATE_DIR}/controllers/<entryId>/<mcp>/
//
// is THE place a child MCP may write, handed to it as MCP_STATE_DIR. One
// directory per (workspace, MCP), so two tenants' memory never share a file.
// The tree sits under the store's own directory, which entrypoint.sh already
// chowns to `mcp` while still root — nesting is what covers it, no new chown.
//
// Not an OS boundary, by decision (D15): every workspace runs as the same uid,
// so any child can read any workspace's directory. 0700 keeps the files off
// other uids and out of a careless volume snapshot; it does not separate
// siblings. A proxy owner who needs that runs separate instances (Phase 3).

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStatePath } from "../config-store/store-file.js";

// Controller entry ids are minted by ConfigStore with randomUUID(). Anything
// else is refused rather than joined into a path: an id is the one input here
// that ever came from a file an operator could hand-edit.
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// MCP names are already dot-free and validated at every source
// (identity/server-name.ts); the check here is belt-and-braces for the path.
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(resolveStatePath(env)), "controllers");
}

/** The directory for one workspace, or undefined for an id that is not an entry id. */
export function workspaceDir(entryId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ENTRY_ID.test(entryId) ? join(workspaceRoot(env), entryId) : undefined;
}

/** Create (0700) and return one MCP's state directory inside a workspace. */
export function ensureMcpStateDir(entryId: string, mcp: string, env: NodeJS.ProcessEnv = process.env): string {
  const ws = workspaceDir(entryId, env);
  if (!ws) throw new Error(`refusing a state directory for controller id ${JSON.stringify(entryId)}`);
  if (!MCP_NAME.test(mcp)) throw new Error(`refusing a state directory for MCP ${JSON.stringify(mcp)}`);
  const dir = join(ws, mcp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Delete a removed workspace's storage. No-op for an id that is not an entry id. */
export function removeWorkspaceStorage(entryId: string, env: NodeJS.ProcessEnv = process.env): void {
  const ws = workspaceDir(entryId, env);
  if (ws) rmSync(ws, { recursive: true, force: true });
}
