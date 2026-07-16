import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@mcp-shim/connector/sdk";
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

export function emptyState(): AgenticMemoryState {
  return { identities: {}, aliasIndex: {}, episodes: {}, semanticCache: {} };
}

export function aliasKey(channel: Channel, normalisedValue: string): string {
  return `${channel}::${normalisedValue}`;
}

const log = createLogger("agentic-memory:state");

// State file path resolution: env override wins (used by tests to isolate),
// then default to `<this-folder>/.state.json`. import.meta.url gets us the
// folder even after tsc compilation into dist/ or when tsx executes the
// source in-place.
export function defaultStatePath(): string {
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
    return {
      identities: parsed.identities ?? {},
      aliasIndex: parsed.aliasIndex ?? {},
      episodes: parsed.episodes ?? {},
      semanticCache: parsed.semanticCache ?? {},
    };
  } catch (err) {
    log.error({ path, err: err as Error }, `failed to load state — starting fresh`);
    return emptyState();
  }
}

export function saveState(path: string, state: AgenticMemoryState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
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

// Singleton — every tool file `import { store } from "../state.js"` and
// mutates through it. The drop-in runner spawns one process; there's no
// shared-mutable concern here beyond the file itself.
export const store = new Store();
