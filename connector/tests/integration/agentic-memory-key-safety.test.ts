import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// MCP-AUDIT #4 — externalId reaches the state maps as a KEY, so an
// unconstrained z.string() let JavaScript's prototype machinery through.
//
// Measured before the fix (the numbered trace is in the audit):
//   identities["__proto__"]            -> Object.prototype, TRUTHY, so the
//                                         identity_not_found guard PASSED
//   identity.mergedInto                -> undefined, so the merged guard PASSED
//   episodes["__proto__"] ?? []        -> Object.prototype, not an array
//   list.push(...)                     -> TypeError: an opaque crash where the
//                                         tool was written to return a clean error
//   semanticCache["__proto__"] = {...} -> REPLACED that map's prototype, after
//                                         which JSON.stringify serialises
//                                         whatever the new prototype exposes and
//                                         a later loadState can silently lose data
//
// Two independent defences, both pinned here: the input schema rejects anything
// that is not a real handle, and the maps are built with Object.create(null) so
// even a key that somehow arrives cannot reach a prototype.

const AM = resolve(__dirname, "../../..", "bundled-mcps/agentic-memory");

type StateMod = {
  emptyState: () => Record<string, Record<string, unknown>>;
  loadState: (p: string) => Record<string, Record<string, unknown>>;
  saveState: (p: string, s: unknown) => void;
};
type SchemaMod = { ExternalIdSchema: { safeParse(v: unknown): { success: boolean } } };
type IdMod = { externalIdFor: (channel: string, value: string) => string };

let state: StateMod;
let schemas: SchemaMod;
let ids: IdMod;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "am-keysafe-"));
  process.env.AGENTIC_MEMORY_STATE_PATH = join(tmp, ".state.json");
  state = (await import(`${AM}/state.ts`)) as StateMod;
  schemas = (await import(`${AM}/schemas.ts`)) as unknown as SchemaMod;
  ids = (await import(`${AM}/id.ts`)) as IdMod;
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("MCP-AUDIT #4 — ExternalIdSchema rejects prototype-shaped keys", () => {
  it("rejects the three names that reach a prototype", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expect(schemas.ExternalIdSchema.safeParse(bad).success, `${bad} must be rejected`).toBe(false);
    }
  });

  it("rejects anything that is not 12 lowercase hex characters", () => {
    for (const bad of ["", "abc", "ABCDEF123456", "abcdef1234567", "abcdef12345g", "  abcdef123456  "]) {
      expect(schemas.ExternalIdSchema.safeParse(bad).success, `${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  it("accepts what externalIdFor actually emits, across channels", () => {
    for (const [channel, value] of [
      ["sms", "+15551234567"],
      ["email", "des@example.com"],
      ["webchat", "some-opaque-session-uuid"],
    ] as const) {
      const id = ids.externalIdFor(channel, value);
      expect(id).toMatch(/^[0-9a-f]{12}$/);
      expect(schemas.ExternalIdSchema.safeParse(id).success, `${channel} id ${id} must be accepted`).toBe(true);
    }
  });
});

describe("MCP-AUDIT #4 — the state maps have no prototype", () => {
  it("emptyState builds all four maps prototype-less", () => {
    const s = state.emptyState();
    for (const key of ["identities", "aliasIndex", "episodes", "semanticCache"]) {
      expect(Object.getPrototypeOf(s[key]), `${key} must have a null prototype`).toBeNull();
    }
  });

  it("a __proto__ lookup returns undefined instead of Object.prototype", () => {
    const s = state.emptyState();
    // This is the exact expression whose truthiness defeated the guard.
    expect(s.identities["__proto__"]).toBeUndefined();
    expect(Boolean(s.identities["__proto__"])).toBe(false);
  });

  it("the `?? []` fallback yields a real array again", () => {
    const s = state.emptyState();
    const list = s.episodes["__proto__"] ?? [];
    expect(Array.isArray(list)).toBe(true);
    expect(() => (list as unknown[]).push({ id: "x" })).not.toThrow();
  });

  it("assigning __proto__ creates an own property instead of replacing the prototype", () => {
    const s = state.emptyState();
    s.semanticCache["__proto__"] = { resolved: {}, sourceRefs: [] };
    expect(Object.getPrototypeOf(s.semanticCache)).toBeNull();
    expect(Object.keys(s.semanticCache)).toContain("__proto__");
  });

  it("loadState rebuilds prototype-less maps — the guarantee survives a restart", () => {
    // JSON.parse returns ordinary objects, so reusing them directly would
    // reintroduce the finding on the first boot after a write.
    const p = join(tmp, "reload.json");
    writeFileSync(p, JSON.stringify({
      identities: { abcdef123456: { externalId: "abcdef123456", aliases: [], createdAt: "t" } },
      aliasIndex: {}, episodes: {}, semanticCache: {},
    }), "utf8");

    const loaded = state.loadState(p);
    for (const key of ["identities", "aliasIndex", "episodes", "semanticCache"]) {
      expect(Object.getPrototypeOf(loaded[key]), `${key} must be null-prototype after load`).toBeNull();
    }
    expect(loaded.identities.abcdef123456).toBeDefined();   // data preserved
    expect(loaded.identities["__proto__"]).toBeUndefined();
  });

  it("survives a save/load round-trip with a __proto__-named own key present", () => {
    const p = join(tmp, "roundtrip.json");
    const s = state.emptyState();
    s.semanticCache["__proto__"] = { resolved: { a: 1 }, sourceRefs: [] };
    state.saveState(p, s);
    const back = state.loadState(p);
    expect(Object.getPrototypeOf(back.semanticCache)).toBeNull();
    // It round-trips as ordinary data rather than corrupting the map.
    expect(back.semanticCache["__proto__"]).toBeDefined();
  });
});

describe("MCP-AUDIT #4 — trip-wire", () => {
  it("no InputSchema leaves a key-bearing field as a bare z.string()", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const toolsDir = join(AM, "tools");
    const offenders: string[] = [];
    for (const f of readdirSync(toolsDir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(toolsDir, f), "utf8");
      const m = /const InputSchema = \{([\s\S]*?)^\};/m.exec(src);
      if (!m) continue;
      // externalId, and the merge tools' winner/loser, all index the state maps.
      if (/\n\s+(externalId|winner|loser): z\.string\(\)/.test(m[1])) offenders.push(f);
    }
    expect(offenders, "these fields index a state map and must use ExternalIdSchema").toEqual([]);
  });
});
