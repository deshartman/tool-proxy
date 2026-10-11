// What an MCP folder offers, learned without a tenant (MULTI-PLATFORM-MCP §5.3,
// D16).
//
// Lazy spawn means a gated MCP has no child until a controller enables it, but
// `mcp-discovered` must still carry its tool list and envKeys — that frame is
// how the platform's pending lane learns there is something to enable. So the
// process spawns each folder ONCE in a scratch supervisor, with no controller
// env and a throwaway MCP_STATE_DIR, reads `/envkeys` and `tools/list`, and
// stops the child. Every workspace then emits mcp-discovered from that result.
//
// Sharing it across workspaces is safe because it describes CODE, not a
// tenant: the scratch child had no controller's creds and wrote into a temp
// directory deleted straight after. The key is the folder's real path plus a
// hash of the files the runner loads, so an edited drop-in is re-described on
// the next rescan and an unchanged one is not respawned.
//
// Known limit, documented rather than solved: a tool list that depends on
// creds (MCP-PROTOCOL.md "Conditional tool registration") is UNDER-reported
// here, because the scratch child has none. The real list ships in the
// manifest once the MCP is enabled and has its creds.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSupervisor, type SupervisedSpec } from "../mcp-supervisor.js";
import type { McpServerConnection } from "../servers/index.js";
import type { PortAllocator } from "../port-allocator.js";
import type { Logger } from "../logger.js";

export interface DiscoveredOffer {
  tools: Array<{ name: string; description?: string }>;
  envKeys: string[];
}

export interface DiscoveryCacheOpts {
  ports: PortAllocator;
  readyTimeoutMs: number;
  log: Logger;
}

// The folders the drop-in runner loads code from. A change anywhere in them is
// a change to what the MCP offers.
const CODE_DIRS = ["tools", "prompts", "resources"];

export class DiscoveryCache {
  private readonly cache = new Map<string, Promise<DiscoveredOffer>>();

  constructor(private readonly opts: DiscoveryCacheOpts) {}

  /**
   * What `spec`'s folder offers. Concurrent callers for the same folder share
   * one spawn. A spawn that fails is NOT cached — the next caller retries —
   * and resolves to an empty offer so one broken folder cannot stall a
   * workspace's mcp-discovered fan-out.
   */
  describe(spec: SupervisedSpec): Promise<DiscoveredOffer> {
    const dir = (spec as { dir?: string }).dir;
    if (!dir) return Promise.resolve({ tools: [], envKeys: [] });
    const key = folderFingerprint(dir);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.spawnAndRead(spec).catch((err) => {
      this.cache.delete(key);
      this.opts.log.warn({ mcp: spec.name, err: err as Error }, `discovery spawn failed — mcp-discovered will carry no tools for it`);
      return { tools: [], envKeys: [] };
    });
    this.cache.set(key, pending);
    return pending;
  }

  private async spawnAndRead(spec: SupervisedSpec): Promise<DiscoveredOffer> {
    const scratchState = mkdtempSync(join(tmpdir(), "mcp-discovery-"));
    const servers = new Map<string, McpServerConnection>();
    const supervisor = new McpSupervisor({
      log: this.opts.log,
      servers,
      ports: this.opts.ports,
      readyTimeoutMs: this.opts.readyTimeoutMs,
      // A throwaway directory, so a child that writes at startup writes
      // nowhere that outlives this call.
      stateDirFor: () => scratchState,
    });
    // A private copy: the supervisor mutates the spec at spawn.
    const copy = structuredClone(spec);
    supervisor.register([copy]);
    try {
      await supervisor.startOne(copy.name, "discovery");
      const envKeys = await supervisor.fetchEnvKeys(copy.name);
      const conn = servers.get(copy.name);
      const tools = conn ? await conn.listTools() : [];
      this.opts.log.info({ mcp: spec.name, tools: tools.length, envKeys }, `described MCP folder for discovery`);
      return { tools: tools.map((t) => ({ name: t.name, description: t.description })), envKeys };
    } finally {
      await supervisor.stopAll();
      rmSync(scratchState, { recursive: true, force: true });
    }
  }
}

/**
 * Real path + content hash of every file the runner would load — the cache
 * key, and what a rescan compares to decide a folder's code changed. Hashing
 * content, not mtimes: a `git checkout` that restores identical bytes is not a
 * change, and a copy that preserves mtimes but changes bytes is.
 */
export function folderFingerprint(dir: string): string {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* the spawn will report it */ }
  const hash = createHash("sha256");
  for (const sub of CODE_DIRS) hashTree(join(real, sub), hash);
  return `${real}#${hash.digest("hex")}`;
}

function hashTree(path: string, hash: ReturnType<typeof createHash>): void {
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(path, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    hash.update(`${name}\0`);
    if (isDir) hashTree(full, hash);
    else {
      try { hash.update(readFileSync(full)); } catch { /* unreadable — the spawn will report it */ }
    }
  }
}
