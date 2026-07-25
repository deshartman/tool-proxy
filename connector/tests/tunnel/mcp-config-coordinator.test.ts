import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { McpConfigCoordinator } from "../../src/tunnel/mcp-config-coordinator.js";
import type {
  McpConfigAckFrame,
  McpConfigDeltaFrame,
  McpConfigEntry,
  McpConfigResyncFrame,
  McpConfigSnapshotFrame,
  TunnelFrame,
} from "../../src/tunnel/frames.js";
import type { McpSupervisor, SupervisedSpec } from "../../src/mcp-supervisor.js";
import type { Logger } from "../../src/logger.js";

// Defensive tests for McpConfigCoordinator (W-E2 of MCP-LOADING).
//
// Manual scenario validated end-to-end on 2026-06-21: operator added
// `aviation-weather` (stdio, auth=none) and `time` (stdio) via the controller
// UI, both registered cleanly into the connector's manifest, dispatched
// tools/call round-trips, then the operator deleted `aviation-weather` and
// the connector re-emitted a manifest without it while leaving the other
// 5 MCPs (4 yaml + 1 roster) untouched.
//
// The invariants pinned below are the load-bearing ones for the v1.1
// controller-driven roster. They guard against silent regressions:
//
//   * mcpId is the routing key for removes — a delta with `removed: [mcpId]`
//     MUST translate to supervisor.unregister(name) via the mcpId→name map.
//     If this breaks, the controller's delete button does nothing on the
//     connector side (manifest still shows the MCP), or worse, removes the
//     wrong one if the lookup is by name.
//   * Yaml entries are immune to controller-roster operations — a name
//     collision between a yaml entry and a controller entry MUST report
//     failed (without shadowing the yaml entry).
//   * Generation gap → resync. A monotonic counter that's allowed to skip
//     would silently desync the roster from the controller's source of
//     truth.
//   * Boot soft-wait fires once. Without it, an older controller that
//     doesn't speak v1.1 would silently leave the connector with an empty
//     3rd-party roster and no log line saying so.
//   * mcpIdFor(name) returns undefined for yaml-listed entries. This is
//     what creds-coordinator threads into creds-request.mcpId so the
//     controller can scope by (connectorId, mcpId) for roster entries
//     while yaml entries fall back to (connectorId, mcp).
//
// We don't touch a real supervisor — the coordinator's contract is five
// methods (hasEntry, registerOne, startOne, replaceSpec, unregister) and a
// fake covers them.

interface FakeLog {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function fakeLogger(): FakeLog {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

interface FakeSupervisor {
  yamlEntries: Set<string>;
  registered: Map<string, SupervisedSpec>;
  started: string[];
  replaced: { name: string; spec: SupervisedSpec; reason: string }[];
  unregistered: string[];
  startOneError?: Error;
  replaceSpecError?: Error;
  unregisterError?: Error;
}

function buildSupervisor(yamlNames: string[] = []): { fake: FakeSupervisor; supervisor: McpSupervisor } {
  const fake: FakeSupervisor = {
    yamlEntries: new Set(yamlNames),
    registered: new Map(),
    started: [],
    replaced: [],
    unregistered: [],
  };
  const supervisor = {
    hasEntry: (name: string) => fake.yamlEntries.has(name) || fake.registered.has(name),
    registerOne: (spec: SupervisedSpec) => { fake.registered.set(spec.name, spec); },
    startOne: async (name: string) => {
      if (fake.startOneError) throw fake.startOneError;
      fake.started.push(name);
      return true;
    },
    replaceSpec: async (name: string, spec: SupervisedSpec, reason: string) => {
      if (fake.replaceSpecError) throw fake.replaceSpecError;
      fake.replaced.push({ name, spec, reason });
      fake.registered.set(name, spec);
      return true;
    },
    unregister: async (name: string) => {
      if (fake.unregisterError) throw fake.unregisterError;
      fake.unregistered.push(name);
      fake.registered.delete(name);
      return true;
    },
  } as unknown as McpSupervisor;
  return { fake, supervisor };
}

function buildCoordinator(yamlNames: string[] = [], snapshotWaitMs = 50) {
  const log = fakeLogger();
  const sent: TunnelFrame[] = [];
  const { fake, supervisor } = buildSupervisor(yamlNames);
  const coordinator = new McpConfigCoordinator({
    send: (frame) => sent.push(frame),
    supervisor,
    log: log as unknown as Logger,
    snapshotWaitMs,
  });
  return { coordinator, log, sent, fake };
}

// Type-narrowing helper so each test doesn't repeat a type-predicate cast
// that the linter flags as redundant on union narrowing.
function findAck(frames: TunnelFrame[]): McpConfigAckFrame | undefined {
  for (const f of frames) if (f.type === "mcp-config-ack") return f;
  return undefined;
}
function findResync(frames: TunnelFrame[]): McpConfigResyncFrame | undefined {
  for (const f of frames) if (f.type === "mcp-config-resync") return f;
  return undefined;
}

const STDIO_AVIATION: McpConfigEntry = {
  mcpId: "mcp_av_001",
  name: "aviation-weather",
  transport: "stdio",
  command: ["npx", "--yes", "aviation-weather-mcp"],
  auth: { kind: "none" },
};
const STDIO_TIME: McpConfigEntry = {
  mcpId: "mcp_time_001",
  name: "time",
  transport: "stdio",
  command: ["npx", "--yes", "mcp-server-time"],
  auth: { kind: "none" },
};

describe("McpConfigCoordinator — snapshot reconciliation", () => {
  it("adds new entries on first snapshot and acks 'started' per mcpId", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    const frame: McpConfigSnapshotFrame = {
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    };

    await coordinator.handleSnapshot(frame);

    expect(fake.registered.size).toBe(2);
    expect(fake.started).toEqual(["aviation-weather", "time"]);
    const ack = findAck(sent);
    expect(ack).toBeDefined();
    expect(ack!.generation).toBe(1);
    expect(ack!.perMcp).toEqual([
      { mcpId: "mcp_av_001", name: "aviation-weather", status: "started" },
      { mcpId: "mcp_time_001", name: "time", status: "started" },
    ]);
  });

  it("removes entries missing from a follow-up snapshot via supervisor.unregister", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });
    sent.length = 0;
    fake.started.length = 0;

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 2,
      servers: [STDIO_TIME],
    });

    expect(fake.unregistered).toEqual(["aviation-weather"]);
    expect(fake.registered.has("aviation-weather")).toBe(false);
    const ack = findAck(sent);
    expect(ack!.perMcp).toContainEqual({
      mcpId: "mcp_av_001",
      name: "aviation-weather",
      status: "removed",
    });
  });

  it("no-ops on an unchanged entry (config bytes equal) — no restart, ack 'started'", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION],
    });
    sent.length = 0;
    fake.started.length = 0;

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 2,
      servers: [STDIO_AVIATION],
    });

    expect(fake.started).toEqual([]);
    expect(fake.replaced).toEqual([]);
    expect(fake.unregistered).toEqual([]);
    const ack = findAck(sent);
    expect(ack!.perMcp).toEqual([
      { mcpId: "mcp_av_001", name: "aviation-weather", status: "started" },
    ]);
  });

  it("drops same-generation snapshots as no-op (WS-reconnect redelivery)", async () => {
    const { coordinator, sent, fake, log } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 5,
      servers: [STDIO_AVIATION],
    });
    sent.length = 0;

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 5,
      servers: [STDIO_TIME],
    });

    expect(fake.registered.has("time")).toBe(false);
    expect(sent).toEqual([]);
    // Same generation as lastApplied is the expected reconnect
    // redelivery case — logged at debug, not warn.
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 5 }),
      expect.stringContaining("redelivered"),
    );
  });

  it("drops snapshots older than lastApplied and warns", async () => {
    const { coordinator, sent, fake, log } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 5,
      servers: [STDIO_AVIATION],
    });
    sent.length = 0;

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 3,
      servers: [STDIO_TIME],
    });

    expect(fake.registered.has("time")).toBe(false);
    expect(sent).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 3, lastApplied: 5 }),
      expect.stringContaining("older than lastApplied"),
    );
  });
});

describe("McpConfigCoordinator — delta CRUD", () => {
  it("removes via mcpId (NOT name) — controller never sends names in removed[]", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });
    sent.length = 0;

    const delta: McpConfigDeltaFrame = {
      type: "mcp-config-delta",
      generation: 2,
      removed: ["mcp_av_001"],
    };
    await coordinator.handleDelta(delta);

    // Translates the mcpId to the right name via the internal nameToMcpId map.
    expect(fake.unregistered).toEqual(["aviation-weather"]);
    expect(fake.registered.has("time")).toBe(true);
    const ack = findAck(sent);
    expect(ack!.perMcp).toEqual([
      { mcpId: "mcp_av_001", name: "aviation-weather", status: "removed" },
    ]);
  });

  it("requests resync when delta.generation > lastApplied + 1 (gap)", async () => {
    const { coordinator, sent } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [],
    });
    sent.length = 0;

    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 5, // expected 2
      added: [STDIO_AVIATION],
    });

    const resync = findResync(sent);
    expect(resync).toEqual({ type: "mcp-config-resync", reason: "gap" });
    // No ack — the coordinator bailed before applying.
    expect(sent.find((f) => f.type === "mcp-config-ack")).toBeUndefined();
  });

  it("treats a delta on an unknown mcpId in updated[] as an add (controller missed an earlier add)", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [],
    });
    sent.length = 0;

    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 2,
      updated: [STDIO_AVIATION],
    });

    expect(fake.started).toEqual(["aviation-weather"]);
    const ack = findAck(sent);
    expect(ack!.perMcp).toEqual([
      { mcpId: "mcp_av_001", name: "aviation-weather", status: "started" },
    ]);
  });

  it("idempotent remove: removing an mcpId we don't track is logged + acked 'removed' (don't crash, don't gap)", async () => {
    const { coordinator, sent, log } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [],
    });
    sent.length = 0;

    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 2,
      removed: ["mcp_unknown"],
    });

    expect(log.warn).toHaveBeenCalledWith(
      { mcpId: "mcp_unknown" },
      expect.stringContaining("unknown mcpId"),
    );
    const ack = findAck(sent);
    expect(ack!.perMcp).toEqual([
      { mcpId: "mcp_unknown", name: "?", status: "removed" },
    ]);
  });
});

describe("McpConfigCoordinator — name collisions", () => {
  it("yaml-clash: ack 'failed' with yaml-specific error message; supervisor never sees registerOne", async () => {
    const { coordinator, sent, fake } = buildCoordinator(["sample"]);
    const clashingEntry: McpConfigEntry = {
      mcpId: "mcp_clash_001",
      name: "sample",
      transport: "stdio",
      command: ["echo"],
      auth: { kind: "none" },
    };

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [clashingEntry],
    });

    expect(fake.registered.size).toBe(0);
    expect(fake.started).toEqual([]);
    const ack = findAck(sent);
    expect(ack!.perMcp[0].status).toBe("failed");
    expect(ack!.perMcp[0].error).toMatch(/yaml entry "sample"/);
  });

  it("roster-clash: a second roster entry with a duplicate name names the OTHER mcpId in the error", async () => {
    const { coordinator, sent } = buildCoordinator();
    const dup: McpConfigEntry = {
      mcpId: "mcp_dup_001",
      name: "aviation-weather",
      transport: "stdio",
      command: ["echo"],
      auth: { kind: "none" },
    };

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION],
    });
    sent.length = 0;

    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 2,
      added: [dup],
    });

    const ack = findAck(sent);
    expect(ack!.perMcp[0].status).toBe("failed");
    expect(ack!.perMcp[0].error).toMatch(/another controller-config entry/);
    expect(ack!.perMcp[0].error).toMatch(/mcp_av_001/);
  });
});

describe("McpConfigCoordinator — unsupported transports report 'skipped'", () => {
  it("sse and websocket transports register + start (W-E5) with __transportKind stamped on the spec", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    const sse: McpConfigEntry = {
      mcpId: "mcp_sse_001",
      name: "remote-sse",
      transport: "sse",
      url: "https://example.com/mcp/sse",
      auth: { kind: "none" },
    };
    const ws: McpConfigEntry = {
      mcpId: "mcp_ws_001",
      name: "remote-ws",
      transport: "websocket",
      url: "wss://example.com/mcp",
      auth: { kind: "none" },
    };

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [sse, ws],
    });

    expect(fake.registered.size).toBe(2);
    expect(fake.started).toEqual(["remote-sse", "remote-ws"]);

    // The supervisor-side spec models only `http` / `stdio` transports.
    // SSE / WebSocket route through the http spec with __transportKind
    // stamped so servers/connect.ts can dispatch to the correct SDK
    // transport class.
    const sseSpec = fake.registered.get("remote-sse") as SupervisedSpec & { __transportKind?: string };
    expect(sseSpec.transport).toBe("http");
    expect(sseSpec.__transportKind).toBe("sse");

    const wsSpec = fake.registered.get("remote-ws") as SupervisedSpec & { __transportKind?: string };
    expect(wsSpec.transport).toBe("http");
    expect(wsSpec.__transportKind).toBe("websocket");

    // streamable-http / http stay undefined — those go through the
    // existing connectHttp default (no kind stamp needed).
    const ack = findAck(sent);
    expect(ack!.perMcp).toHaveLength(2);
    for (const row of ack!.perMcp) {
      expect(row.status).toBe("started");
    }
  });

  it("streamable-http / http roster entries leave __transportKind undefined (default to connectHttp)", async () => {
    const { coordinator, fake } = buildCoordinator();
    const httpEntry: McpConfigEntry = {
      mcpId: "mcp_http_001",
      name: "remote-http",
      transport: "http",
      url: "https://example.com/mcp",
      auth: { kind: "none" },
    };
    const streamableEntry: McpConfigEntry = {
      mcpId: "mcp_streamable_001",
      name: "remote-streamable",
      transport: "streamable-http",
      url: "https://example.com/mcp/v2",
      auth: { kind: "none" },
    };

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [httpEntry, streamableEntry],
    });

    const httpSpec = fake.registered.get("remote-http") as SupervisedSpec & { __transportKind?: string };
    expect(httpSpec.__transportKind).toBeUndefined();
    const streamableSpec = fake.registered.get("remote-streamable") as SupervisedSpec & { __transportKind?: string };
    expect(streamableSpec.__transportKind).toBeUndefined();
  });

  it("stdio missing command and http missing url are skipped with a specific error", async () => {
    const { coordinator, sent } = buildCoordinator();
    const badStdio: McpConfigEntry = {
      mcpId: "mcp_bad_stdio",
      name: "no-cmd",
      transport: "stdio",
      auth: { kind: "none" },
    };
    const badHttp: McpConfigEntry = {
      mcpId: "mcp_bad_http",
      name: "no-url",
      transport: "http",
      auth: { kind: "none" },
    };

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [badStdio, badHttp],
    });

    const ack = findAck(sent);
    expect(ack!.perMcp[0]).toMatchObject({ status: "skipped" });
    expect(ack!.perMcp[0].error).toMatch(/missing command/);
    expect(ack!.perMcp[1]).toMatchObject({ status: "skipped" });
    expect(ack!.perMcp[1].error).toMatch(/missing url/);
  });
});

describe("McpConfigCoordinator — mcpIdFor lookup (creds-request enrichment)", () => {
  it("returns the mcpId for a roster entry; undefined for yaml-listed names", async () => {
    const { coordinator } = buildCoordinator(["sample", "crm"]);
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });

    expect(coordinator.mcpIdFor("aviation-weather")).toBe("mcp_av_001");
    expect(coordinator.mcpIdFor("time")).toBe("mcp_time_001");
    // Yaml entries — coordinator never saw them, so no mcpId.
    expect(coordinator.mcpIdFor("sample")).toBeUndefined();
    expect(coordinator.mcpIdFor("crm")).toBeUndefined();
    // Unknown name — also undefined (not an error).
    expect(coordinator.mcpIdFor("does-not-exist")).toBeUndefined();
  });

  it("a remove drops the name→mcpId mapping (yaml-fallback semantics restore on delete)", async () => {
    const { coordinator } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION],
    });
    expect(coordinator.mcpIdFor("aviation-weather")).toBe("mcp_av_001");

    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 2,
      removed: ["mcp_av_001"],
    });

    expect(coordinator.mcpIdFor("aviation-weather")).toBeUndefined();
  });
});

describe("McpConfigCoordinator — boot soft-wait", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires mcp-config-resync { reason: 'boot' } when no snapshot arrives within the soft-wait window", () => {
    const { coordinator, sent, log } = buildCoordinator([], 5000);
    coordinator.armSnapshotWait();

    vi.advanceTimersByTime(5001);

    const resync = findResync(sent);
    expect(resync).toEqual({ type: "mcp-config-resync", reason: "boot" });
    expect(log.warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("soft-wait elapsed"),
    );
  });

  it("an arriving snapshot cancels the soft-wait timer (no boot resync emitted)", async () => {
    const { coordinator, sent } = buildCoordinator([], 5000);
    coordinator.armSnapshotWait();

    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [],
    });

    vi.advanceTimersByTime(10000);

    const resync = sent.find((f) => f.type === "mcp-config-resync");
    expect(resync).toBeUndefined();
  });

  it("does not double-fire on a second arm() — the prior timer is cancelled", () => {
    const { coordinator, sent } = buildCoordinator([], 5000);
    coordinator.armSnapshotWait();
    vi.advanceTimersByTime(2500);
    coordinator.armSnapshotWait();
    vi.advanceTimersByTime(2501);

    // Only the second timer is live now; first should not fire.
    const resyncs = sent.filter((f) => f.type === "mcp-config-resync");
    expect(resyncs).toHaveLength(0);

    vi.advanceTimersByTime(5001);
    const after = sent.filter((f) => f.type === "mcp-config-resync");
    expect(after).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Reconnect survival — pins the 2026-06-21 bug.
//
// Manual scenario: operator added `time` via the controller UI on tunnel
// session A. WS reconnected (e.g. ngrok cycle, controller restart). On
// tunnel session B, register-ack arrived and the controller pushed
// `mcp-config-snapshot { generation: 3, servers: [<NEW time row>] }` —
// note the snapshot did NOT include the prior `time` row (operator had
// deleted it through the UI).
//
// Expected: coordinator's "Removed" loop drops the prior session's
// `time` (its mcpId is no longer in the snapshot), then "Added" loop
// installs the new `time`. Bug: coordinator was rebuilt per tunnel, so
// its `roster` was empty at session B's snapshot — the "Removed" loop
// no-op'd, the "Added" loop hit `supervisor.hasEntry("time") → true`
// (left over from session A) and reported a false "yaml-clash" failure.
//
// Fix: coordinator survives WS reconnect; only the wire `send` callback
// is swapped via `bind()`. The roster + lastAppliedGeneration are
// steady-state membership and MUST persist across tunnels.
//
// These three cases pin the invariant from three angles:
//
//   1. Roster survives bind() — the simplest assertion.
//   2. The exact bug repro: add via session A, snapshot via session B
//      that omits the prior entry → supervisor.unregister runs.
//   3. Snapshot-wait timer DOES NOT survive bind() — that timer is
//      tunnel-scoped (a snapshot expected on tunnel A must not fire a
//      resync onto tunnel B if tunnel A closed without one). The
//      timer's purpose is "wait for snapshot since last register-ack".
// ──────────────────────────────────────────────────────────────────────
describe("McpConfigCoordinator — reconnect survival via bind()", () => {
  it("roster + lastAppliedGeneration persist across bind() (WS reconnect)", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });
    expect(fake.started).toEqual(["aviation-weather", "time"]);
    expect(coordinator.mcpIdFor("aviation-weather")).toBe("mcp_av_001");

    // Simulate WS reconnect: a new send hook arrives via bind().
    const sentB: TunnelFrame[] = [];
    coordinator.bind({ send: (f) => sentB.push(f) });

    // Pre-bind state survives.
    expect(coordinator.mcpIdFor("aviation-weather")).toBe("mcp_av_001");
    expect(coordinator.mcpIdFor("time")).toBe("mcp_time_001");

    // The OLD send hook MUST NOT receive any subsequent frames.
    sent.length = 0;

    // A snapshot that drops gen=1 as same-generation redelivery proves
    // lastAppliedGeneration also persisted (otherwise gen=1 would
    // re-apply and run startOne again).
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });

    expect(fake.started).toEqual(["aviation-weather", "time"]); // unchanged
    expect(sent).toEqual([]); // old hook silent
    expect(sentB).toEqual([]); // redelivered snapshot doesn't ack either
  });

  it("post-reconnect snapshot omitting a prior entry calls supervisor.unregister (THE BUG)", async () => {
    // Session A: operator added `time` via the controller UI.
    const { coordinator, sent, fake } = buildCoordinator();
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_TIME],
    });
    expect(fake.started).toEqual(["time"]);
    expect(fake.registered.has("time")).toBe(true);
    sent.length = 0;
    fake.started.length = 0;

    // WS reconnect.
    const sentB: TunnelFrame[] = [];
    coordinator.bind({ send: (f) => sentB.push(f) });

    // Session B: operator deleted the old `time` row + added a NEW `time`.
    // Controller's snapshot for this connector is now `{ NEW_TIME }` —
    // the prior mcpId is GONE.
    const NEW_TIME: McpConfigEntry = {
      mcpId: "mcp_f43f13ac",
      name: "time",
      transport: "stdio",
      command: ["uvx", "mcp-server-time"],
      auth: { kind: "none" },
    };
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 3,
      servers: [NEW_TIME],
    });

    // The "Removed" loop unregistered the prior session's `time`.
    expect(fake.unregistered).toEqual(["time"]);
    // Then the "Added" loop installed the new one — supervisor.hasEntry no
    // longer collides because unregister ran first.
    expect(fake.started).toEqual(["time"]);
    expect(coordinator.mcpIdFor("time")).toBe("mcp_f43f13ac");

    // Ack reflects both transitions and goes to the NEW tunnel only.
    const ack = findAck(sentB);
    expect(ack).toBeDefined();
    expect(ack!.generation).toBe(3);
    expect(ack!.perMcp).toContainEqual({ mcpId: "mcp_time_001", name: "time", status: "removed" });
    expect(ack!.perMcp).toContainEqual({ mcpId: "mcp_f43f13ac", name: "time", status: "started" });
    // Old tunnel must not have received the ack.
    expect(findAck(sent)).toBeUndefined();
  });

  it("snapshot-wait timer is cancelled by bind() — a stale arm() can't fire on a fresh tunnel", () => {
    vi.useFakeTimers();
    try {
      const { coordinator, sent } = buildCoordinator([], 5000);
      coordinator.armSnapshotWait();
      vi.advanceTimersByTime(2500);

      // WS reconnect mid-wait. The arm was made for the OLD tunnel; if its
      // timer were allowed to fire, the resync would land on the NEW
      // tunnel's `send` (which is fine), but the controller would receive
      // a spurious resync request the operator never asked for. Worse, if
      // bind() didn't also reset the timer, two arm() calls back-to-back
      // (boot reconnect cycles) would queue up multiple resync emissions.
      const sentB: TunnelFrame[] = [];
      coordinator.bind({ send: (f) => sentB.push(f) });

      vi.advanceTimersByTime(10_000);

      // Neither the old nor the new wire saw a resync — bind() killed the timer.
      expect(findResync(sent)).toBeUndefined();
      expect(findResync(sentB)).toBeUndefined();

      // A fresh arm() works as expected — timer behaviour isn't broken,
      // just scoped per-tunnel.
      coordinator.armSnapshotWait();
      vi.advanceTimersByTime(5001);
      expect(findResync(sentB)).toEqual({ type: "mcp-config-resync", reason: "boot" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Pre-spawn creds fetch (TWILIO-MCP-BREAKOUT bug 2).
//
// Manual scenario captured 2026-06-28: operator added a standalone
// `twilio-mcp` (stdio, 21 tools gated on TWILIO_ACCOUNT_SID +
// TWILIO_AUTH_TOKEN) via the "New 3rd Party MCP" UI. Connector spawned the
// child immediately and reported `Live · 0 tools` because boot-time
// requestCredsForAllMcps iterates `servers.keys()` (the connected MCP set)
// BEFORE the controller-config snapshot lands — so no creds-request ever
// fires for roster entries, the supervisor's controllerEnv stays empty,
// and the child's process.env carries no Twilio creds. Subsequent discovery
// probes hit the empty server and crash with -32601 because McpServer's
// tools/list handler is only wired on the first registerTool() call.
//
// The fix wires a per-tunnel `requestCreds(name, mcpId, envKeys)` callback
// into the coordinator's bind() shape. addEntry awaits it BEFORE startOne
// so the supervisor's controllerEnv is populated by the time the spawn
// fires. Symmetric with the boot-time fan-out for yaml + drop-in entries.
//
// The invariants pinned below:
//   (a) addEntry awaits requestCreds before startOne (ordering pin — if
//       this regresses, the standalone twilio-mcp boots at 0 tools again).
//   (b) A new entry from a delta (post-register-ack add, the common operator
//       path) triggers the same fetch.
//   (c) updateEntry triggers the fetch in BOTH the rename branch and the
//       replaceSpec branch (envKeys could change in either; over-fetching
//       is harmless because creds-response is idempotent).
//   (d) requestCreds throwing does NOT block the spawn — the warn already
//       logs, and the child can fail-fast with its own clear error if creds
//       were genuinely required.
//   (e) An unbound coordinator (no requestCreds callback supplied to bind)
//       falls back to the no-op default and addEntry still works — keeps
//       backward compat for unit tests and any future caller that doesn't
//       wire creds.
describe("McpConfigCoordinator — pre-spawn creds fetch (bug 2)", () => {
  it("(a) addEntry awaits requestCreds BEFORE startOne — ordering pin", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    const callOrder: string[] = [];
    let credsResolved = false;
    let resolveCreds: () => void = () => undefined;
    const credsPromise = new Promise<void>((r) => { resolveCreds = r; });

    // Wrap the fake supervisor's startOne to record when it was called.
    const origStartOne = fake.started;
    const sup = (coordinator as unknown as { opts: { supervisor: McpSupervisor } }).opts.supervisor;
    const origStartOneFn = sup.startOne.bind(sup);
    (sup as unknown as { startOne: McpSupervisor["startOne"] }).startOne = async (name: string, reason?: string) => {
      callOrder.push(`startOne:${name}:credsResolved=${credsResolved}`);
      return origStartOneFn(name, reason ?? "test");
    };

    coordinator.bind({
      send: (f) => sent.push(f),
      requestCreds: async (name, mcpId, envKeys) => {
        callOrder.push(`requestCreds:${name}:envKeys=[${envKeys.join(",")}]`);
        await credsPromise;
        credsResolved = true;
      },
    });

    // Build a snapshot for the standalone twilio entry — same shape the
    // controller produces from its "New 3rd Party MCP" form.
    const TWILIO_ENTRY: McpConfigEntry = {
      mcpId: "mcp_twilio_001",
      name: "twilio",
      transport: "stdio",
      command: ["twilio-mcp"],
      auth: { kind: "none" },
      envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    };

    const applyPromise = coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [TWILIO_ENTRY],
    });

    // Microtask flush so the coordinator's awaits queue up. After this,
    // requestCreds should be in flight but NOT yet resolved → startOne
    // MUST NOT have been called.
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual([
      "requestCreds:twilio:envKeys=[TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN]",
    ]);
    expect(fake.started).toEqual([]);

    // Now let the creds fetch resolve. After applyPromise settles, startOne
    // MUST have been called AND credsResolved=true at the time of the call.
    resolveCreds();
    await applyPromise;
    expect(callOrder).toEqual([
      "requestCreds:twilio:envKeys=[TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN]",
      "startOne:twilio:credsResolved=true",
    ]);
    expect(fake.started).toEqual(["twilio"]);
    expect(origStartOne).toBe(fake.started); // sanity: same array reference
  });

  it("(b) delta-added entries trigger the same fetch", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    const credsCalls: Array<{ name: string; mcpId: string; envKeys: string[] }> = [];

    coordinator.bind({
      send: (f) => sent.push(f),
      requestCreds: async (name, mcpId, envKeys) => {
        credsCalls.push({ name, mcpId, envKeys });
      },
    });

    // Empty snapshot first so lastAppliedGeneration = 1 (delta.gen = 2 below
    // is exactly one above — no gap-resync triggered).
    await coordinator.handleSnapshot({ type: "mcp-config-snapshot", generation: 1, servers: [] });

    const ADDED: McpConfigEntry = {
      mcpId: "mcp_seg_001",
      name: "segment",
      transport: "stdio",
      command: ["segment-mcp"],
      auth: { kind: "none" },
      envKeys: ["SEGMENT_WRITE_KEY"],
    };
    await coordinator.handleDelta({
      type: "mcp-config-delta",
      generation: 2,
      added: [ADDED],
    });

    expect(credsCalls).toEqual([
      { name: "segment", mcpId: "mcp_seg_001", envKeys: ["SEGMENT_WRITE_KEY"] },
    ]);
    expect(fake.started).toEqual(["segment"]);
  });

  it("(c) updateEntry rename + replaceSpec branches both fetch creds", async () => {
    const { coordinator, sent, fake } = buildCoordinator();
    const credsCalls: Array<{ name: string; envKeys: string[] }> = [];

    coordinator.bind({
      send: (f) => sent.push(f),
      requestCreds: async (name, _mcpId, envKeys) => {
        credsCalls.push({ name, envKeys });
      },
    });

    const INITIAL: McpConfigEntry = {
      mcpId: "mcp_t_001",
      name: "twilio-api",
      transport: "stdio",
      command: ["twilio-mcp"],
      auth: { kind: "none" },
      envKeys: ["TWILIO_ACCOUNT_SID"],
    };
    await coordinator.handleSnapshot({ type: "mcp-config-snapshot", generation: 1, servers: [INITIAL] });
    // initial add → 1 fetch
    expect(credsCalls).toHaveLength(1);

    // Same name, new command — replaceSpec branch.
    const REPLACED: McpConfigEntry = { ...INITIAL, command: ["twilio-mcp", "--verbose"] };
    await coordinator.handleDelta({ type: "mcp-config-delta", generation: 2, updated: [REPLACED] });
    expect(credsCalls).toHaveLength(2);
    expect(credsCalls[1]?.name).toBe("twilio-api");
    expect(fake.replaced.map((r) => r.name)).toEqual(["twilio-api"]);

    // Now a rename — drop+register+startOne branch.
    const RENAMED: McpConfigEntry = { ...REPLACED, name: "twilio" };
    await coordinator.handleDelta({ type: "mcp-config-delta", generation: 3, updated: [RENAMED] });
    expect(credsCalls).toHaveLength(3);
    expect(credsCalls[2]?.name).toBe("twilio");
    expect(fake.unregistered).toContain("twilio-api");
    expect(fake.started).toContain("twilio");
  });

  it("(d) requestCreds throwing does NOT block the spawn — warn logged, startOne still runs", async () => {
    const { coordinator, sent, fake, log } = buildCoordinator();

    coordinator.bind({
      send: (f) => sent.push(f),
      requestCreds: async () => {
        throw new Error("controller unreachable");
      },
    });

    const ENTRY: McpConfigEntry = {
      mcpId: "mcp_x_001",
      name: "broken-creds",
      transport: "stdio",
      command: ["some-mcp"],
      auth: { kind: "none" },
      envKeys: ["SOME_KEY"],
    };
    await coordinator.handleSnapshot({ type: "mcp-config-snapshot", generation: 1, servers: [ENTRY] });

    // Spawn proceeded.
    expect(fake.started).toEqual(["broken-creds"]);
    // Warn surfaced for the operator.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mcp: "broken-creds", err: "controller unreachable" }),
      expect.stringContaining("pre-spawn creds fetch failed"),
    );
    // Ack is still `started` — the spawn succeeded; the creds may arrive
    // late via a creds-update push later. (Worst case the child boots with
    // empty env and registers zero tools — but that's the legacy behaviour
    // we're recovering from, not a new failure mode.)
    expect(findAck(sent)).toMatchObject({ perMcp: [{ status: "started" }] });
  });

  it("(e) an unbound coordinator (no requestCreds callback) still works — backward compat", async () => {
    // Default behaviour with the constructor's no-op requestCreds — should
    // be indistinguishable from pre-bug2 behaviour for callers that never
    // bound a real fetcher (e.g. older test files, any future caller that
    // only wants the snapshot reconciliation half of the coordinator).
    const { coordinator, fake, sent } = buildCoordinator();
    // Note: NO coordinator.bind() — using the constructor's no-op default.

    const ENTRY: McpConfigEntry = {
      mcpId: "mcp_y_001",
      name: "unbound-creds",
      transport: "stdio",
      command: ["whatever"],
      auth: { kind: "none" },
    };
    await coordinator.handleSnapshot({ type: "mcp-config-snapshot", generation: 1, servers: [ENTRY] });

    expect(fake.started).toEqual(["unbound-creds"]);
    expect(findAck(sent)).toMatchObject({ perMcp: [{ status: "started" }] });
  });
});
