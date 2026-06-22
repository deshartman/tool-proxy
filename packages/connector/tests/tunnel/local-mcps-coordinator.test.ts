import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalMcpsCoordinator } from "../../src/tunnel/local-mcps-coordinator.js";
import type { McpSupervisor, McpStatus, SupervisedSpec } from "../../src/mcp-supervisor.js";
import type { Logger } from "../../src/logger.js";
import type { LocalMcpsRescanAckFrame, TunnelFrame } from "../../src/tunnel/frames.js";

// Defensive tests for LocalMcpsCoordinator (W-L2 of MCP-LOADING-LOCAL).
//
// The coordinator's contract:
//   * rescan() runs discoverDropins({yamlNames}) against MCP_DROPIN_DIR and
//     reconciles by diff against the supervisor's status list (entries with
//     source: "local" are the ones we manage — yaml + controller-config
//     entries are NOT touched by rescan).
//   * Added folders → registerOne with source:"local" → startOne → onMcpAdded
//   * Removed folders → unregister
//   * Already-known folders → unchanged in the ack
//   * Single-flight: a second click while a rescan is mid-flight returns an
//     empty ack (the in-flight scan covers the same disk state)
//   * Errors per folder are isolated — one bad drop-in does not abort the
//     scan; it shows up in the ack's `errors` array.

interface FakeSupervisor {
  statuses: McpStatus[];
  registered: Map<string, SupervisedSpec>;
  started: string[];
  unregistered: string[];
  startOneError?: Error;
}

function fakeLogger(): Logger {
  const log = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    trace: vi.fn(), silent: vi.fn(), level: "info",
  } as unknown as Logger;
  (log as unknown as { child: () => Logger }).child = () => log;
  return log;
}

function buildSupervisor(initial: McpStatus[] = []): { fake: FakeSupervisor; supervisor: McpSupervisor } {
  const fake: FakeSupervisor = {
    statuses: [...initial],
    registered: new Map(),
    started: [],
    unregistered: [],
  };
  const supervisor = {
    hasEntry: (name: string) => fake.statuses.some((s) => s.name === name) || fake.registered.has(name),
    registerOne: (spec: SupervisedSpec, meta?: { source?: string }) => {
      fake.registered.set(spec.name, spec);
      fake.statuses.push({
        name: spec.name,
        process: "stopped",
        credsSource: "none",
        restartCount: 0,
        toolsCount: 0,
        source: (meta?.source as McpStatus["source"]) ?? "local",
      });
    },
    startOne: async (name: string) => {
      if (fake.startOneError) throw fake.startOneError;
      fake.started.push(name);
      const idx = fake.statuses.findIndex((s) => s.name === name);
      if (idx >= 0) fake.statuses[idx] = { ...fake.statuses[idx], process: "running", toolsCount: 1 };
      return true;
    },
    unregister: async (name: string) => {
      fake.unregistered.push(name);
      fake.statuses = fake.statuses.filter((s) => s.name !== name);
      fake.registered.delete(name);
      return true;
    },
    statusList: () => fake.statuses.map((s) => ({ ...s })),
  } as unknown as McpSupervisor;
  return { fake, supervisor };
}

function makeDropinFolder(root: string, name: string, toolFiles: string[] = ["foo.ts"]): void {
  const dir = join(root, name, "tools");
  mkdirSync(dir, { recursive: true });
  for (const file of toolFiles) writeFileSync(join(dir, file), "// stub");
}

describe("LocalMcpsCoordinator — rescan reconciles drop-in folders", () => {
  let dropinRoot: string;

  beforeEach(() => {
    dropinRoot = mkdtempSync(join(tmpdir(), "mcp-l2-"));
    process.env.MCP_DROPIN_DIR = dropinRoot;
  });

  afterEach(() => {
    delete process.env.MCP_DROPIN_DIR;
    rmSync(dropinRoot, { recursive: true, force: true });
  });

  it("first rescan adds every fresh folder with source:'local' and acks 'added'", async () => {
    makeDropinFolder(dropinRoot, "orders");
    makeDropinFolder(dropinRoot, "inventory");

    const sent: TunnelFrame[] = [];
    const { fake, supervisor } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: (f) => sent.push(f),
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    const ack = await coord.rescan();
    expect(ack.added.map((a) => a.name).sort()).toEqual(["inventory", "orders"]);
    expect(ack.removed).toEqual([]);
    expect(ack.errors).toEqual([]);
    expect(fake.started.sort()).toEqual(["inventory", "orders"]);
    expect(fake.statuses.find((s) => s.name === "orders")?.source).toBe("local");
  });

  it("second rescan with no disk changes reports unchanged for prior local entries", async () => {
    makeDropinFolder(dropinRoot, "orders");
    const { supervisor, fake } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    await coord.rescan();
    fake.started.length = 0;

    const ack = await coord.rescan();
    expect(ack.added).toEqual([]);
    expect(ack.removed).toEqual([]);
    expect(ack.unchanged).toEqual(["orders"]);
    expect(fake.started).toEqual([]);
  });

  it("removes prior local entries that disappear from disk via supervisor.unregister", async () => {
    makeDropinFolder(dropinRoot, "orders");
    makeDropinFolder(dropinRoot, "inventory");
    const { supervisor, fake } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    await coord.rescan();
    rmSync(join(dropinRoot, "inventory"), { recursive: true });

    const ack = await coord.rescan();
    expect(ack.removed).toEqual(["inventory"]);
    expect(fake.unregistered).toEqual(["inventory"]);
    expect(ack.unchanged).toEqual(["orders"]);
  });

  it("rescanFromController emits the ack frame on the wire", async () => {
    makeDropinFolder(dropinRoot, "orders");
    const sent: TunnelFrame[] = [];
    const { supervisor } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: (f) => sent.push(f),
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    await coord.rescanFromController();
    const ack = sent.find((f): f is LocalMcpsRescanAckFrame => f.type === "local-mcps-rescan-ack");
    expect(ack).toBeDefined();
    expect(ack!.added.map((a) => a.name)).toEqual(["orders"]);
  });

  it("does NOT touch entries with source other than 'local' (yaml + controller-config are immune)", async () => {
    // Pre-seeded supervisor has a yaml entry "twilio-bundled" and a
    // controller-config entry "aviation-weather". A rescan that sees neither
    // on disk MUST NOT unregister them.
    const initial: McpStatus[] = [
      { name: "twilio-bundled", process: "running", credsSource: "none", restartCount: 0, toolsCount: 5, source: "yaml" },
      { name: "aviation-weather", process: "running", credsSource: "none", restartCount: 0, toolsCount: 8, source: "controller-config" },
    ];
    const { supervisor, fake } = buildSupervisor(initial);
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(["twilio-bundled"]),
    });

    const ack = await coord.rescan();
    expect(fake.unregistered).toEqual([]);
    expect(ack.removed).toEqual([]);
  });

  it("isolates per-folder errors — one bad drop-in does not abort the scan", async () => {
    makeDropinFolder(dropinRoot, "good");
    makeDropinFolder(dropinRoot, "broken");

    const { supervisor, fake } = buildSupervisor();
    let calls = 0;
    const startOne = vi.fn().mockImplementation(async (name: string) => {
      calls += 1;
      if (name === "broken") throw new Error("synthetic spawn failure");
      fake.started.push(name);
      return true;
    });
    (supervisor as unknown as { startOne: typeof startOne }).startOne = startOne;

    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    const ack = await coord.rescan();
    expect(calls).toBe(2);
    expect(ack.errors.length).toBe(1);
    expect(ack.errors[0].name).toBe("broken");
    expect(ack.added.map((a) => a.name)).toEqual(["good"]);
  });

  it("single-flight: a second concurrent rescan returns an empty ack", async () => {
    makeDropinFolder(dropinRoot, "orders");
    const { supervisor } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
    });

    const first = coord.rescan();
    const second = coord.rescan();
    const [a, b] = await Promise.all([first, second]);
    // One of them ran, the other returned an empty ack.
    const realRun = a.added.length === 1 ? a : b;
    const coalesced = a.added.length === 1 ? b : a;
    expect(realRun.added.map((x) => x.name)).toEqual(["orders"]);
    expect(coalesced.added).toEqual([]);
    expect(coalesced.removed).toEqual([]);
    expect(coalesced.unchanged).toEqual([]);
  });

  it("yaml-name collision is handled by the dropin scanner — yamlNames are skipped", async () => {
    // A folder that shares a yaml entry's name MUST be skipped by
    // discoverDropins({yamlNames}). The coordinator never sees it as
    // "fresh"; the supervisor's yaml entry stays unchanged.
    makeDropinFolder(dropinRoot, "twilio-bundled");
    const initial: McpStatus[] = [
      { name: "twilio-bundled", process: "running", credsSource: "none", restartCount: 0, toolsCount: 5, source: "yaml" },
    ];
    const { supervisor, fake } = buildSupervisor(initial);

    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(["twilio-bundled"]),
    });
    const ack = await coord.rescan();
    expect(ack.added).toEqual([]);
    expect(ack.unchanged).toEqual([]);
    expect(fake.started).toEqual([]);
    expect(fake.unregistered).toEqual([]);
  });

  it("calls onMcpAdded for each new MCP so the boot wiring can fan out a creds-request", async () => {
    makeDropinFolder(dropinRoot, "orders");
    makeDropinFolder(dropinRoot, "inventory");

    const onMcpAdded = vi.fn().mockResolvedValue(undefined);
    const { supervisor } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
      onMcpAdded,
    });

    await coord.rescan();
    expect(onMcpAdded).toHaveBeenCalledTimes(2);
    expect(onMcpAdded.mock.calls.map((c) => c[0]).sort()).toEqual(["inventory", "orders"]);
  });

  it("calls onApplied exactly once per rescan when the diff is non-empty", async () => {
    makeDropinFolder(dropinRoot, "orders");
    const onApplied = vi.fn().mockResolvedValue(undefined);
    const { supervisor } = buildSupervisor();
    const coord = new LocalMcpsCoordinator({
      send: () => undefined,
      supervisor,
      log: fakeLogger(),
      yamlNames: new Set(),
      onApplied,
    });

    await coord.rescan();
    expect(onApplied).toHaveBeenCalledTimes(1);

    onApplied.mockClear();
    await coord.rescan();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
