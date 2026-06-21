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

  it("drops snapshots with generation <= lastApplied (out-of-order / duplicate)", async () => {
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
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 5, lastApplied: 5 }),
      expect.stringContaining("superseded"),
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
  it("sse and websocket are honestly reported as skipped (W-E5 deferred), not silently dropped", async () => {
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

    expect(fake.registered.size).toBe(0);
    expect(fake.started).toEqual([]);
    const ack = findAck(sent);
    expect(ack!.perMcp).toHaveLength(2);
    for (const row of ack!.perMcp) {
      expect(row.status).toBe("skipped");
      expect(row.error).toMatch(/not yet supported/);
    }
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

    // A snapshot that drops gen=1 as superseded proves lastAppliedGeneration
    // also persisted (otherwise gen=1 would re-apply and run startOne again).
    await coordinator.handleSnapshot({
      type: "mcp-config-snapshot",
      generation: 1,
      servers: [STDIO_AVIATION, STDIO_TIME],
    });

    expect(fake.started).toEqual(["aviation-weather", "time"]); // unchanged
    expect(sent).toEqual([]); // old hook silent
    expect(sentB).toEqual([]); // superseded snapshot doesn't ack either
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
