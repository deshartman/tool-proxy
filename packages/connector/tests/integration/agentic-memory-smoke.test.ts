import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// End-to-end smoke walk of MEMORY-MCP-INTERFACE.md §11.1. Exercises the
// agentic-memory drop-in the way the connector's dropin-runner would: load
// its tools, prompts, resources, and capabilities from disk; boot a real
// StreamableHTTP server; connect a real MCP client; run the §11.1
// checklist steps in order.
//
// State is redirected to a tmpdir via AGENTIC_MEMORY_STATE_PATH so this
// test never touches the repo's .state.json. All imports of the drop-in
// (which construct the singleton Store at module-load time) are DEFERRED
// via dynamic import inside beforeAll — the env var MUST be set first.

const DROPIN_DIR = resolve(__dirname, "../../../..", "mcp/local/agentic-memory");

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown> | undefined; isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const contentArr = Array.isArray(result.content) ? result.content : [];
  const first = contentArr[0] as { type?: string; text?: string } | undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  return {
    structured: (result.structuredContent as Record<string, unknown> | undefined),
    isError: Boolean(result.isError),
    text,
  };
}

describe("agentic-memory drop-in — §11.1 validation walk", () => {
  let tmpDir: string;
  let handle: { port: number; close: () => Promise<void> };
  let client: Client;
  // Store type widened to `any` at this layer to avoid coupling the test to
  // the drop-in's internal types; the shape is exercised through the wire.
  let store: { state: unknown; commit: () => void };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentic-memory-smoke-"));
    process.env.AGENTIC_MEMORY_STATE_PATH = join(tmpDir, "state.json");

    const stateMod = await import(`${DROPIN_DIR}/state.ts`);
    store = stateMod.store;
    const emptyState = stateMod.emptyState;

    const { loadCategory, loadCapabilities, isToolShape, isPromptShape, isResourceShape } =
      await import("@connector/sdk/dropin-discovery.js");
    const { createMcpHttpServer } = await import("@connector/sdk/http-server.js");
    const { createLogger } = await import("@connector/logger.js");
    const log = createLogger("agentic-memory-smoke");

    const tools = await loadCategory(DROPIN_DIR, "tools", "tool", isToolShape, log);
    const prompts = await loadCategory(DROPIN_DIR, "prompts", "prompt", isPromptShape, log);
    const resources = await loadCategory(DROPIN_DIR, "resources", "resource", isResourceShape, log);
    const capabilities = await loadCapabilities(DROPIN_DIR, log);

    expect(tools.length).toBe(14);
    expect(prompts.length).toBe(3);
    expect(resources.length).toBe(3);
    expect(capabilities).toBeDefined();

    handle = await createMcpHttpServer({
      name: "agentic-memory",
      tools,
      prompts,
      resources,
      capabilities,
      port: 0,
    });

    client = new Client({ name: "agentic-memory-smoke", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);

    // Reset the store for the whole run — the singleton loaded state from
    // the (nonexistent) tmp path so it's already empty, but re-run to be
    // explicit and to write the tmp file so subsequent tests see it.
    store.state = emptyState();
    store.commit();
  });

  afterAll(async () => {
    if (client) await client.close();
    if (handle) await handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const stateMod = await import(`${DROPIN_DIR}/state.ts`);
    store.state = stateMod.emptyState();
    store.commit();
  });

  it("Step 1 — capabilities handshake exposes the §7 shape under experimental.agentic-memory", () => {
    const caps = client.getServerCapabilities() as Record<string, unknown> | undefined;
    expect(caps).toBeDefined();
    const experimental = caps!.experimental as Record<string, unknown> | undefined;
    const am = experimental!["agentic-memory"] as Record<string, unknown>;
    expect(am.protocolVersion).toBe("2026-07");
    expect(am.identity).toBeDefined();
    expect(am.memory).toBeDefined();
    expect(am.unknownFieldBehavior).toBe("ignore");
  });

  it("Step 2 — all 14 required tools are advertised", async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "identity_add_alias",
      "identity_list_aliases",
      "identity_lookup",
      "identity_merge",
      "identity_remove_alias",
      "identity_resolve",
      "memory_episodic_append",
      "memory_episodic_recall",
      "memory_semantic_agent_flush",
      "memory_semantic_get",
      "memory_semantic_merge_identities",
      "memory_semantic_prune_refs",
      "memory_semantic_upsert_refs",
      "memory_semantic_write_resolved",
    ]);
  });

  it("Step 3 — identity_lookup returns null for an unknown identifier", async () => {
    const res = await callTool(client, "identity_lookup", {
      channel: "voice",
      value: "+15550000000",
    });
    expect(res.isError).toBe(false);
    expect(res.structured).toEqual({ externalId: null, aliases: [] });
  });

  it("Step 4 — identity_resolve on a fresh phone returns isNew=true and a stable externalId", async () => {
    const res = await callTool(client, "identity_resolve", {
      channel: "voice",
      value: "+15551234567",
    });
    expect(res.isError).toBe(false);
    const s = res.structured!;
    expect(s.isNew).toBe(true);
    expect(typeof s.externalId).toBe("string");
    expect((s.externalId as string).length).toBeGreaterThan(0);
    const aliases = s.aliases as Array<{ channel: string; value: string }>;
    expect(aliases).toEqual([expect.objectContaining({ channel: "voice", value: "+15551234567" })]);

    // Same call again → isNew=false, same externalId (deterministic).
    const again = await callTool(client, "identity_resolve", {
      channel: "voice",
      value: "+15551234567",
    });
    expect(again.structured!.externalId).toBe(s.externalId);
    expect(again.structured!.isNew).toBe(false);
  });

  it("Step 5 — round-trip: resolve → add_alias → list_aliases → episodic → semantic → flush", async () => {
    const resolve = await callTool(client, "identity_resolve", {
      channel: "voice",
      value: "+15559999999",
    });
    const externalId = resolve.structured!.externalId as string;

    // add_alias
    const add = await callTool(client, "identity_add_alias", {
      externalId,
      channel: "email",
      value: "Alice@Example.COM",
    });
    expect(add.structured).toEqual({ success: true, wasAlreadyPresent: false });

    // idempotent add — same normalised value
    const readd = await callTool(client, "identity_add_alias", {
      externalId,
      channel: "email",
      value: "alice@example.com",
    });
    expect(readd.structured).toEqual({ success: true, wasAlreadyPresent: true });

    // list_aliases returns phone + email
    const listed = await callTool(client, "identity_list_aliases", { externalId });
    const listedAliases = listed.structured!.aliases as Array<{ channel: string; value: string }>;
    expect(listedAliases.map((a) => a.channel).sort()).toEqual(["email", "voice"]);
    expect(listedAliases.find((a) => a.channel === "email")!.value).toBe("alice@example.com");

    // episodic append + recall
    const now = new Date().toISOString();
    const append = await callTool(client, "memory_episodic_append", {
      externalId,
      summary: "Alice called to check on order 12345; promised callback tomorrow.",
      metadata: { channelKind: "voice", sessionKey: "call-1", occurredAt: now },
    });
    expect(append.structured!.success).toBe(true);
    expect(typeof append.structured!.episodeId).toBe("string");

    const recall = await callTool(client, "memory_episodic_recall", {
      externalId,
      query: "",
      opts: {},
    });
    const eps = recall.structured!.episodes as Array<{ summary: string; score: number }>;
    expect(eps.length).toBe(1);
    expect(eps[0]?.summary).toMatch(/order 12345/);

    // semantic upsert + get
    const upsert = await callTool(client, "memory_semantic_upsert_refs", {
      externalId,
      additionalRefs: [{ id: "p1", label: "order-lookup", kind: "procedure", target: "procedure:order" }],
      now,
    });
    const upserted = upsert.structured!;
    expect((upserted.sourceRefs as unknown[]).length).toBe(1);

    const get1 = await callTool(client, "memory_semantic_get", { externalId });
    expect((get1.structured!.sourceRefs as unknown[]).length).toBe(1);

    // write_resolved overwrites resolved bag
    const write = await callTool(client, "memory_semantic_write_resolved", {
      externalId,
      resolved: { plan: "gold", loyaltyTier: 3 },
      hydratedAt: now,
    });
    expect(write.structured!.success).toBe(true);

    // agent_flush clears sourceRefs but preserves resolved
    const flush = await callTool(client, "memory_semantic_agent_flush", {
      externalId,
      flushedAt: now,
    });
    expect(flush.structured!.flushed).toBe(true);

    const get2 = await callTool(client, "memory_semantic_get", { externalId });
    expect((get2.structured!.sourceRefs as unknown[]).length).toBe(0);
    expect(get2.structured!.resolved).toEqual({ plan: "gold", loyaltyTier: 3 });
  });

  it("Step 6 — optional tools are implemented (supportsPruneRefs, supportsIdentityMerge both true)", async () => {
    // memory_semantic_prune_refs — no-op when no matching refs
    const prune = await callTool(client, "memory_semantic_prune_refs", {
      deletedCanonical: "procedure:does-not-exist",
    });
    expect(prune.structured!.removedCount).toBe(0);

    // memory_semantic_merge_identities — success even when neither has cache
    const merge = await callTool(client, "memory_semantic_merge_identities", {
      winner: "aaaaaaaaaaaa",
      loser: "bbbbbbbbbbbb",
      mergedAt: new Date().toISOString(),
    });
    expect(merge.structured!.success).toBe(true);
  });

  it("Step 7 — identity_merge tombstones the loser and subsequent externalId=loser lookups raise identity_merged", async () => {
    const a = await callTool(client, "identity_resolve", { channel: "voice", value: "+15550001111" });
    const b = await callTool(client, "identity_resolve", { channel: "voice", value: "+15550002222" });
    const winner = a.structured!.externalId as string;
    const loser = b.structured!.externalId as string;
    const now = new Date().toISOString();

    const merge = await callTool(client, "identity_merge", { winner, loser, mergedAt: now });
    expect(merge.structured!.success).toBe(true);
    expect(merge.structured!.aliasesMigrated).toBe(1);

    // Subsequent externalId=loser add_alias raises identity_merged with mergedInto
    const attempt = await callTool(client, "identity_add_alias", {
      externalId: loser,
      channel: "email",
      value: "bob@example.com",
    });
    expect(attempt.isError).toBe(true);
    const err = JSON.parse(attempt.text) as { error: { code: string; mergedInto?: string } };
    expect(err.error.code).toBe("identity_merged");
    expect(err.error.mergedInto).toBe(winner);

    // Alias-based lookup on loser's old phone now returns winner
    const lookup = await callTool(client, "identity_lookup", {
      channel: "voice",
      value: "+15550002222",
    });
    expect(lookup.structured!.externalId).toBe(winner);
  });

  it("Step 8 — prompts round-trip (bootstrap_context / summarize_episode / merge_review)", async () => {
    const promptsList = await client.listPrompts();
    const names = promptsList.prompts.map((p) => p.name).sort();
    expect(names).toEqual(["bootstrap_context", "merge_review", "summarize_episode"]);

    const seed = await callTool(client, "identity_resolve", {
      channel: "email",
      value: "carol@example.com",
    });
    const externalId = seed.structured!.externalId as string;
    const bs = await client.getPrompt({ name: "bootstrap_context", arguments: { externalId } });
    const bsMsg = bs.messages[0]?.content;
    expect(bsMsg && "text" in bsMsg ? bsMsg.text : "").toMatch(new RegExp(externalId));

    const sm = await client.getPrompt({
      name: "summarize_episode",
      arguments: { transcript: "user: hi\nagent: hello", channelKind: "chat" },
    });
    expect(sm.messages.length).toBe(1);
  });

  it("Step 9 — resources round-trip (identity_aliases / memory_episodes / stats_global)", async () => {
    const listed = await client.listResources();
    // stats_global is static; aliases / episodes are template-based (may appear only via templates/list)
    expect(listed.resources.some((r) => r.uri === "stats://global")).toBe(true);

    const templates = await client.listResourceTemplates();
    const tUris = templates.resourceTemplates.map((r) => r.uriTemplate);
    expect(tUris).toContain("identity://aliases/{externalId}");
    expect(tUris).toContain("memory://episodes/{externalId}");

    const seed = await callTool(client, "identity_resolve", {
      channel: "sms",
      value: "+15558887777",
    });
    const externalId = seed.structured!.externalId as string;

    const stats = await client.readResource({ uri: "stats://global" });
    const statsBody = JSON.parse((stats.contents[0] as { text: string }).text) as { identityCount: number };
    expect(statsBody.identityCount).toBeGreaterThanOrEqual(1);

    const aliases = await client.readResource({ uri: `identity://aliases/${externalId}` });
    const aliasBody = JSON.parse((aliases.contents[0] as { text: string }).text) as { aliases: unknown[] };
    expect(aliasBody.aliases.length).toBe(1);

    const episodes = await client.readResource({ uri: `memory://episodes/${externalId}` });
    const epBody = JSON.parse((episodes.contents[0] as { text: string }).text) as { episodes: unknown[] };
    expect(Array.isArray(epBody.episodes)).toBe(true);
  });

  it("Step 10 — invalid_identifier on unparsable phone", async () => {
    const bad = await callTool(client, "identity_resolve", {
      channel: "voice",
      value: "abc",
    });
    expect(bad.isError).toBe(true);
    const err = JSON.parse(bad.text) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_identifier");
  });
});
