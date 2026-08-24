import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// MCP-AUDIT #18 — nothing bounded what agentic-memory WROTE.
//
// capabilities.ts advertises maxQueryLength: 2000, maxResults: 50 and
// maxSourceRefs: 1000, but every one of those bounds recall. On the write side
// `summary` was a bare z.string(), the per-identity episode list had no cap, and
// sourceRefs grew without limit — while saveState re-serializes the ENTIRE state
// on every commit(), so cost per append grew with total accumulated state
// (O(n^2) across a long-running demo).
//
// Two kinds of limit, and the distinction is the point:
//   * advertised INPUT limits (summary length, maxSourceRefs) are the caller's
//     error when exceeded, and are reported. Accepting the write and silently
//     dropping the overflow would make the advertised number a lie.
//   * the episode cap is RETENTION, not an advertised limit — the append is
//     valid, so it trims oldest-first and logs.

const AM = resolve(__dirname, "../../..", "bundled-mcps/agentic-memory");

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}>;

function captureHandler(tool: { register(server: unknown): void }): Handler {
  let handler: Handler | undefined;
  tool.register({
    registerTool: (_n: string, _s: unknown, fn: Handler) => { handler = fn; },
  } as never);
  if (!handler) throw new Error("tool did not register a handler");
  return handler;
}

// zod validation lives in the MCP SDK's registerTool wrapper, which is bypassed
// when the handler is captured directly — so input limits are asserted against
// the schema itself, and behavioural limits against the handler.
type Schemas = {
  SUMMARY_MAX_CHARS: number;
  MAX_EPISODES_PER_IDENTITY: number;
  MAX_SOURCE_REFS: number;
  SummarySchema: { safeParse(v: unknown): { success: boolean } };
};

let schemas: Schemas;
let capabilities: Record<string, never>;
let append: Handler;
let upsertRefs: Handler;
let store: { state: Record<string, Record<string, unknown>> };
let tmp: string;

const ID = "abcdef123456";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "am-limits-"));
  process.env.AGENTIC_MEMORY_STATE_PATH = join(tmp, ".state.json");
  schemas = (await import(`${AM}/schemas.ts`)) as unknown as Schemas;
  capabilities = (await import(`${AM}/capabilities.ts`)).default;
  store = (await import(`${AM}/state.ts`)).store;
  append = captureHandler((await import(`${AM}/tools/memory-episodic-append.ts`)).default);
  upsertRefs = captureHandler((await import(`${AM}/tools/memory-semantic-upsert-refs.ts`)).default);
  // A live identity for both tools to write against.
  store.state.identities[ID] = { externalId: ID, aliases: [], createdAt: new Date(0).toISOString() };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const meta = {
  channelKind: "sms",
  sessionKey: "sess-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
};

describe("summary length is an advertised input limit (MCP-AUDIT #18)", () => {
  it("accepts a summary at the cap", () => {
    expect(schemas.SummarySchema.safeParse("x".repeat(schemas.SUMMARY_MAX_CHARS)).success).toBe(true);
  });

  it("rejects one character over", () => {
    expect(schemas.SummarySchema.safeParse("x".repeat(schemas.SUMMARY_MAX_CHARS + 1)).success).toBe(false);
  });
});

describe("episode retention cap (MCP-AUDIT #18)", () => {
  it("trims oldest-first and never exceeds the cap", async () => {
    const cap = schemas.MAX_EPISODES_PER_IDENTITY;
    // Seed to just under the cap directly, then drive the last few through the
    // handler so the trim path itself is what runs.
    store.state.episodes[ID] = Array.from({ length: cap - 2 }, (_, i) => ({
      id: `seed-${i}`, summary: `seed ${i}`, ...meta,
    }));

    for (const n of [1, 2, 3, 4]) {
      const res = await append({ externalId: ID, summary: `live ${n}`, metadata: meta });
      expect(res.isError, `append ${n} must succeed`).toBeFalsy();
    }

    const list = store.state.episodes[ID] as unknown as Array<{ summary: string }>;
    expect(list.length).toBe(cap);
    // The two oldest seeds fell off; the newest appends are all present.
    expect(list[0].summary).toBe("seed 2");
    expect(list.slice(-4).map((e) => e.summary)).toEqual(["live 1", "live 2", "live 3", "live 4"]);
  });
});

describe("maxSourceRefs is enforced, not just advertised (MCP-AUDIT #18)", () => {
  const ref = (i: number) => ({ kind: "order", label: `ref-${i}`, target: `t-${i}` });

  it("matches the number capabilities.ts advertises", () => {
    const advertised = (capabilities as unknown as {
      extensions: { "agentic-memory": { memory: { semantic: { maxSourceRefs: number } } } };
    }).extensions["agentic-memory"].memory.semantic.maxSourceRefs;
    expect(schemas.MAX_SOURCE_REFS).toBe(advertised);
  });

  it("accepts refs up to the cap", async () => {
    store.state.semanticCache[ID] = { resolved: {}, sourceRefs: [], hydratedAt: meta.occurredAt };
    const res = await upsertRefs({
      externalId: ID,
      additionalRefs: Array.from({ length: schemas.MAX_SOURCE_REFS }, (_, i) => ref(i)),
      now: meta.occurredAt,
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent?.sourceRefs as unknown[]).length).toBe(schemas.MAX_SOURCE_REFS);
  });

  it("refuses the write that would exceed it, rather than dropping the overflow", async () => {
    const res = await upsertRefs({ externalId: ID, additionalRefs: [ref(99999)], now: meta.occurredAt });
    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content[0].text) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("storage_full");
    expect(err.error.message).toMatch(/maxSourceRefs 1000/);
    // Nothing was written — the caller can trust the rejection.
    const cache = store.state.semanticCache[ID] as unknown as { sourceRefs: unknown[] };
    expect(cache.sourceRefs.length).toBe(schemas.MAX_SOURCE_REFS);
  });

  it("re-sending refs already held does not count against the cap", async () => {
    // The merge is dedup-by-key, so a caller replaying its own refs must still
    // succeed at exactly the cap — a naive length check would reject this.
    const res = await upsertRefs({ externalId: ID, additionalRefs: [ref(0), ref(1)], now: meta.occurredAt });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent?.sourceRefs as unknown[]).length).toBe(schemas.MAX_SOURCE_REFS);
  });
});
