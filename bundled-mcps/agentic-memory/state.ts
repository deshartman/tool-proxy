import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@gtmi/toolproxy-connector/sdk";
import { toolError, type ToolErrorResult } from "./errors.js";
import type { Channel } from "./normalize.js";

// JSON-persisted mock state for the agentic-memory drop-in. The whole state
// object lives in memory; every mutating tool writes it back to disk via an
// atomic tmp+rename. State survives connector restarts, so demos across
// bounces reproduce the same identities and episodes.
//
// This module is intentionally simple — one file, one lock-free writer.
// The drop-in is single-process (one child per drop-in folder), so we
// don't need multi-writer coordination.

export interface HydrationReference {
  id: string;
  label: string;
  kind: "procedure" | "tool" | "hydration";
  role?: "hydration" | "action";
  target?: string;
}

export interface AliasEntry {
  channel: Channel;
  value: string;
  addedAt: string;
}

export interface Episode {
  id: string;
  summary: string;
  channelKind: Channel;
  sessionKey: string;
  occurredAt: string;
  procedureId?: string;
}

export interface SemanticCache {
  resolved: Record<string, unknown>;
  sourceRefs: HydrationReference[];
  hydratedAt?: string;
  lastEngagedAt?: string;
}

export interface IdentityRow {
  externalId: string;
  aliases: AliasEntry[];
  createdAt: string;
  mergedInto?: string;
}

export interface AgenticMemoryState {
  identities: Record<string, IdentityRow>;
  aliasIndex: Record<string, string>;
  episodes: Record<string, Episode[]>;
  semanticCache: Record<string, SemanticCache>;
}

// MCP-AUDIT #4: the four maps are keyed by caller-supplied strings, so they are
// built WITHOUT a prototype. A plain `{}` makes `map["__proto__"]` resolve to
// Object.prototype (truthy — it defeated the identity_not_found guard) and makes
// `map["__proto__"] = obj` replace the map's prototype. Object.create(null) has
// neither behaviour. loadState must rebuild the same way: JSON.parse returns
// ordinary objects, so the guarantee is lost on reload otherwise.
function bareMap<T>(from?: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (from) for (const k of Object.keys(from)) out[k] = from[k] as T;
  return out;
}

export function emptyState(): AgenticMemoryState {
  return {
    identities: bareMap(),
    aliasIndex: bareMap(),
    episodes: bareMap(),
    semanticCache: bareMap(),
  };
}

export function aliasKey(channel: Channel, normalisedValue: string): string {
  return `${channel}::${normalisedValue}`;
}

const log = createLogger("agentic-memory:state");

// State file path resolution, in order:
//   1. MCP_STATE_DIR — the connector's write contract (MULTI-PLATFORM-MCP
//      §5.3): one directory per (workspace, MCP), so each controller's memory
//      lives in its own file. Set by the supervisor on every spawn.
//   2. AGENTIC_MEMORY_STATE_PATH — the pre-Phase-6 override (the Dockerfile
//      sets it; tests use it to isolate).
//   3. `<this-folder>/.state.json` — import.meta.url gets us the folder even
//      after tsc compilation into dist/ or when tsx executes the source.
export function defaultStatePath(): string {
  const stateDir = process.env.MCP_STATE_DIR;
  if (stateDir && stateDir.length > 0) return resolvePath(stateDir, ".state.json");
  const override = process.env.AGENTIC_MEMORY_STATE_PATH;
  if (override && override.length > 0) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, ".state.json");
}

export function loadState(path: string): AgenticMemoryState {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.trim().length === 0) return emptyState();
    const parsed = JSON.parse(raw) as Partial<AgenticMemoryState>;
    // Rebuild as prototype-less maps — see bareMap. JSON.parse hands back
    // ordinary objects, so reusing them directly would reintroduce MCP-AUDIT #4
    // on the first restart after a write.
    return {
      identities: bareMap(parsed.identities),
      aliasIndex: bareMap(parsed.aliasIndex),
      episodes: bareMap(parsed.episodes),
      semanticCache: bareMap(parsed.semanticCache),
    };
  } catch (err) {
    log.error({ path, err: err as Error }, `failed to load state — starting fresh`);
    return emptyState();
  }
}

// MCP-AUDIT #3 + #30. Two things beyond the original tmp+rename:
//
//   * The parent directory is created on demand. In production the path is
//     /var/lib/mcp-connector/agentic-memory/.state.json (set via the Dockerfile
//     ENV) and that leaf dir does not exist until we make it. It must NOT live
//     inside /app — that tree is root-owned on purpose, so writing there failed
//     EACCES in the image while passing in dev.
//   * The file is 0600, set explicitly rather than left to `0666 & ~umask`
//     (which is 0644 under Alpine's default 022 — measured). Contents are PII:
//     conversation summaries, channel aliases, and hydrated customer data.
//     Applied to the tmp file, because rename carries the inode's mode across —
//     and re-applied after, since a pre-existing target can retain its own mode
//     on some platforms.
//
// Note what 0600 does NOT buy: sibling isolation. Every MCP child runs as the
// same uid, so a sibling drop-in is this file's owner. What it closes is
// off-host and cross-uid exposure — volume snapshots, backups, a re-mount, a
// later sidecar. Sibling isolation needs per-MCP uids; see MCP-AUDIT #1a / #30.
const STATE_FILE_MODE = 0o600;

export function saveState(path: string, state: AgenticMemoryState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  chmodSync(tmp, STATE_FILE_MODE);
  renameSync(tmp, path);
  chmodSync(path, STATE_FILE_MODE);
}

// The drop-in creates a single Store instance at boot; every tool imports
// it. Mutations go through commit(), which persists synchronously — the
// mock's write volume is trivial. If tests need isolation they set the env
// var before importing this module.
export class Store {
  readonly path: string;
  state: AgenticMemoryState;

  constructor(path: string = defaultStatePath()) {
    this.path = path;
    this.state = loadState(path);
  }

  commit(): void {
    saveState(this.path, this.state);
  }
}

// MCP-AUDIT #3: tools MUST persist through this, not through bare
// `store.commit()`. A commit can fail for real, environmental reasons — a
// read-only mount, a full volume, a path the process cannot write — and every
// one of the ten mutating tools previously called `commit()` naked, so the
// failure surfaced as an opaque throw. The MCP SDK turns that into `isError:
// true` and the connector relays it, so nothing crashed, but the caller learned
// only "something went wrong" for what is a specific, actionable condition.
//
// Returns undefined on success, or the structured `storage_full` envelope to
// return directly. Retryable: the operator freeing space or fixing the mount
// makes the same call work.
//
//     const failed = commitOrError();
//     if (failed) return failed;
//
// Pinned by tests/integration/agentic-memory-state-persistence.test.ts, which
// also asserts no tool calls bare commit().
export function commitOrError(): ToolErrorResult | undefined {
  try {
    store.commit();
    return undefined;
  } catch (err) {
    const message = (err as Error).message;
    log.error({ path: store.path, err: err as Error }, `failed to persist state`);
    return toolError("storage_full", `could not persist memory state: ${message}`, {
      retryable: true,
    });
  }
}

// Singleton — every tool file `import { store } from "../state.js"` and
// mutates through it. The drop-in runner spawns one process; there's no
// shared-mutable concern here beyond the file itself.
export const store = new Store();
