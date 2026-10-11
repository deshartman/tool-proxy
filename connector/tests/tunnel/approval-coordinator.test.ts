import { describe, it, expect, vi } from "vitest";

import { ApprovalCoordinator } from "../../src/tunnel/approval-coordinator.js";
import type {
  McpDisableFrame,
  McpDiscoveredFrame,
  McpEnableAckFrame,
  McpEnableFrame,
  TunnelFrame,
} from "../../src/tunnel/frames.js";
import type { McpStatus, McpSupervisor } from "../../src/mcp-supervisor.js";
import type { Logger } from "../../src/logger.js";

// Defensive tests for the v1.3 customer drop-in approval gate.
//
// The invariants pinned below are load-bearing for the gate's correctness:
//
//   * The approved set is the runtime gate. handleEnable must mutate it
//     BEFORE the manifest rebuild so onManifestChange's buildManifest
//     consults the new state.
//   * onManifestChange MUST be awaited before the ack fires (the v1.3
//     frame-ordering rule: manifest-delta precedes mcp-enable-ack).
//   * Disable preserves the child — the test fake's supervisor would
//     surface a stop call as a hard failure.
//   * Re-enable after disable is sub-second and idempotent — no spawn,
//     no creds restart unless env changed.
//   * Since Phase 2c every MCP the connector runs itself is gated (bundled,
//     drop-in, yaml); only controller-config (Type 2) is not_gated.
//     Yaml-listed and controller-config MCPs reply with not_gated.
//   * applyControllerEnv failure rolls back the approved-set entry so the
//     operator's view matches what the connector exposes.
//   * bind({send}) swaps the wire callback without resetting the approved
//     set — required for replay-on-reconnect to work.

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
  statuses: Map<string, McpStatus>;
  appliedEnv: Array<{ mcp: string; env: Record<string, string>; source: string; reason: string }>;
  applyControllerEnvError?: Error;
}

function buildSupervisor(initial: McpStatus[] = []): { fake: FakeSupervisor; supervisor: McpSupervisor } {
  const fake: FakeSupervisor = {
    statuses: new Map(initial.map((s) => [s.name, s])),
    appliedEnv: [],
  };
  const supervisor = {
    statusList: () => [...fake.statuses.values()],
    applyControllerEnv: async (mcp: string, env: Record<string, string>, source: string, reason: string) => {
      if (fake.applyControllerEnvError) throw fake.applyControllerEnvError;
      fake.appliedEnv.push({ mcp, env, source, reason });
      return { applied: true, restarted: true };
    },
  } as unknown as McpSupervisor;
  return { fake, supervisor };
}

function buildCoord(opts: {
  fakeSupervisor: ReturnType<typeof buildSupervisor>;
  onManifestChange?: () => void | Promise<void>;
}): {
  coord: ApprovalCoordinator;
  sent: TunnelFrame[];
  log: FakeLog;
  manifestChangeCount: { value: number };
} {
  const sent: TunnelFrame[] = [];
  const log = fakeLogger();
  const counter = { value: 0 };
  const coord = new ApprovalCoordinator({
    send: (frame) => { sent.push(frame); },
    supervisor: opts.fakeSupervisor.supervisor,
    log: log as unknown as Logger,
    onManifestChange: opts.onManifestChange ?? (() => { counter.value += 1; }),
  });
  return { coord, sent, log, manifestChangeCount: counter };
}

function localStatus(name: string, toolsCount = 0): McpStatus {
  return {
    name,
    process: "running",
    credsSource: "none",
    restartCount: 0,
    toolsCount,
    source: "local",
  };
}

function yamlStatus(name: string): McpStatus {
  return {
    name,
    process: "running",
    credsSource: "none",
    restartCount: 0,
    toolsCount: 0,
    source: "yaml",
  };
}

function controllerStatus(name: string): McpStatus {
  return {
    name,
    process: "running",
    credsSource: "none",
    restartCount: 0,
    toolsCount: 0,
    source: "controller-config",
    mcpId: "mcp_xyz",
  };
}

describe("ApprovalCoordinator — emitDiscovered", () => {
  it("emits a wire-shaped mcp-discovered frame", () => {
    const fake = buildSupervisor();
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    coord.emitDiscovered({
      mcp: "crm",
      author: "customer",
      source: "dropin",
      envKeys: ["MOCK_CUSTOMERS_URL"],
      tools: [
        { name: "get_customer", description: "..." },
        { name: "issue_refund" },
      ],
    });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as McpDiscoveredFrame;
    expect(frame.type).toBe("mcp-discovered");
    expect(frame.mcp).toBe("crm");
    // The two literal fields are the gate predicate — they must always be
    // these exact values, never derived from the spec.
    expect(frame.author).toBe("customer");
    // Wire value since Phase 2c; the supervisor still says "local" internally.
    expect(frame.source).toBe("dropin");
    expect(frame.envKeys).toEqual(["MOCK_CUSTOMERS_URL"]);
    expect(frame.tools).toHaveLength(2);
    // discoveredAt is wall-clock — ensure it's present + ISO8601-shaped.
    expect(frame.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("ApprovalCoordinator — handleEnable", () => {
  it("flips approved + fires manifest change + acks enabled with toolsCount", async () => {
    const fake = buildSupervisor([localStatus("crm", 3)]);
    const { coord, sent, manifestChangeCount } = buildCoord({ fakeSupervisor: fake });

    expect(coord.isApproved("crm")).toBe(false);
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });

    expect(coord.isApproved("crm")).toBe(true);
    expect(manifestChangeCount.value).toBe(1);
    expect(sent).toHaveLength(1);
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.type).toBe("mcp-enable-ack");
    expect(ack.mcp).toBe("crm");
    expect(ack.status).toBe("enabled");
    expect(ack.toolsCount).toBe(3);
  });

  it("applies env via supervisor when present, with operator-entered source", async () => {
    const fake = buildSupervisor([localStatus("crm", 3)]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({
      type: "mcp-enable",
      mcp: "crm",
      env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" },
      source: "operator-entered",
    });

    expect(fake.fake.appliedEnv).toHaveLength(1);
    expect(fake.fake.appliedEnv[0]).toEqual({
      mcp: "crm",
      env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" },
      source: "operator-entered",
      reason: "mcp-enable",
    });
    expect((sent[0] as McpEnableAckFrame).status).toBe("enabled");
  });

  it("is idempotent when re-enabling an already-approved MCP (no env field)", async () => {
    const fake = buildSupervisor([localStatus("crm", 2)]);
    const { coord, sent, manifestChangeCount } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    expect(manifestChangeCount.value).toBe(1);

    // Re-enable: no exception, ack still fires (the controller may rely on
    // the ack for replay confirmation), no env applied (none in payload).
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    expect(coord.isApproved("crm")).toBe(true);
    expect(fake.fake.appliedEnv).toHaveLength(0);
    expect(manifestChangeCount.value).toBe(2); // hook called both times — idempotent at the boot wiring level
    expect((sent[1] as McpEnableAckFrame).status).toBe("enabled");
  });

  it("rejects unknown MCP with unknown_mcp", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "ghost" });

    expect(coord.isApproved("ghost")).toBe(false);
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.status).toBe("error");
    expect(ack.error).toBe("unknown_mcp");
  });

  // Phase 2c (D3): yaml entries are gated now, so mcp-enable must ACCEPT them.
  // This test used to pin the opposite ("rejects yaml with not_gated").
  it("accepts mcp-enable for a yaml-listed MCP (gated since Phase 2c)", async () => {
    const fake = buildSupervisor([yamlStatus("twilio")]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "twilio" });

    expect(coord.isApproved("twilio")).toBe(true);
    const ack = sent[sent.length - 1] as McpEnableAckFrame;
    expect(ack.status).toBe("enabled");
  });

  it("rejects controller-config MCP with not_gated reason", async () => {
    const fake = buildSupervisor([controllerStatus("aviation-weather")]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "aviation-weather" });

    expect(coord.isApproved("aviation-weather")).toBe(false);
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.status).toBe("error");
    expect(ack.error).toContain("not_gated");
    expect(ack.error).toContain("3rd-party");
  });

  it("rolls back approved-set on applyControllerEnv failure", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    fake.fake.applyControllerEnvError = new Error("supervisor restart timed out");
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({
      type: "mcp-enable",
      mcp: "crm",
      env: { K: "v" },
    });

    // Critical: failed approval must NOT leave the gate flipped — the
    // operator's view should match what the connector actually exposes.
    expect(coord.isApproved("crm")).toBe(false);
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.status).toBe("error");
    expect(ack.error).toContain("apply_env_failed");
    expect(ack.error).toContain("supervisor restart timed out");
  });

  it("preserves prior approval on applyControllerEnv failure during a re-enable", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    // First approval succeeds.
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    expect(coord.isApproved("crm")).toBe(true);

    // Operator updates env; supervisor restart fails. The MCP was approved
    // before this attempt, so we keep it approved (the prior tools are
    // still callable; only the new env didn't land).
    fake.fake.applyControllerEnvError = new Error("boom");
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm", env: { K: "v" } });
    expect(coord.isApproved("crm")).toBe(true);
    const ack = sent[1] as McpEnableAckFrame;
    expect(ack.status).toBe("error");
  });

  it("awaits onManifestChange before sending the ack (frame ordering)", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    const order: string[] = [];
    const sent: TunnelFrame[] = [];
    const log = fakeLogger();

    const coord = new ApprovalCoordinator({
      send: (frame) => {
        order.push(`send:${frame.type}`);
        sent.push(frame);
      },
      supervisor: fake.supervisor,
      log: log as unknown as Logger,
      onManifestChange: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("onManifestChange:done");
      },
    });

    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });

    // Manifest change MUST resolve before the ack is sent — otherwise the
    // controller can ack a "ready" state where the manifest-delta hasn't
    // landed yet, and a subsequent tools/call races against the new manifest.
    expect(order).toEqual(["onManifestChange:done", "send:mcp-enable-ack"]);
  });
});

describe("ApprovalCoordinator — handleDisable", () => {
  it("clears approved + fires manifest change + acks disabled (child kept running)", async () => {
    const fake = buildSupervisor([localStatus("crm", 3)]);
    const { coord, sent, manifestChangeCount } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    expect(coord.isApproved("crm")).toBe(true);

    await coord.handleDisable({ type: "mcp-disable", mcp: "crm" });
    expect(coord.isApproved("crm")).toBe(false);
    expect(manifestChangeCount.value).toBe(2);

    // No supervisor stop call — the fake supervisor doesn't expose `stop`,
    // and the coordinator must not invent one. DA5: disable is manifest-
    // visibility-only, not a lifecycle gate.
    expect(fake.fake.appliedEnv).toHaveLength(0);

    const ack = sent[1] as McpEnableAckFrame;
    expect(ack.type).toBe("mcp-enable-ack");
    expect(ack.status).toBe("disabled");
    expect(ack.toolsCount).toBeUndefined();
  });

  it("disable on never-approved MCP is a no-op except for the ack", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    const { coord, sent, manifestChangeCount } = buildCoord({ fakeSupervisor: fake });

    await coord.handleDisable({ type: "mcp-disable", mcp: "crm" });

    expect(coord.isApproved("crm")).toBe(false);
    // No manifest rebuild — there was nothing to remove.
    expect(manifestChangeCount.value).toBe(0);
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.status).toBe("disabled");
  });

  it("rejects unknown MCP with unknown_mcp", async () => {
    const fake = buildSupervisor([localStatus("crm")]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    await coord.handleDisable({ type: "mcp-disable", mcp: "ghost" });
    const ack = sent[0] as McpEnableAckFrame;
    expect(ack.status).toBe("error");
    expect(ack.error).toBe("unknown_mcp");
  });

  it("re-enable after disable flips back without spawn (no env path triggered)", async () => {
    const fake = buildSupervisor([localStatus("crm", 2)]);
    const { coord, sent, manifestChangeCount } = buildCoord({ fakeSupervisor: fake });

    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    await coord.handleDisable({ type: "mcp-disable", mcp: "crm" });
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });

    expect(coord.isApproved("crm")).toBe(true);
    // No env was applied at any point — re-enable bypassed the supervisor
    // entirely (no spawn cost). This is the DA5 promise: re-enable is
    // sub-second.
    expect(fake.fake.appliedEnv).toHaveLength(0);
    expect(manifestChangeCount.value).toBe(3);
    expect(sent).toHaveLength(3);
    expect((sent[2] as McpEnableAckFrame).status).toBe("enabled");
  });
});

describe("ApprovalCoordinator — bind / lifetime", () => {
  it("bind({send}) swaps the wire callback without resetting the approved set", async () => {
    const fake = buildSupervisor([localStatus("crm", 1)]);
    const tunnel1: TunnelFrame[] = [];
    const tunnel2: TunnelFrame[] = [];
    const log = fakeLogger();

    const coord = new ApprovalCoordinator({
      send: (frame) => { tunnel1.push(frame); },
      supervisor: fake.supervisor,
      log: log as unknown as Logger,
      onManifestChange: () => {},
    });

    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    expect(coord.isApproved("crm")).toBe(true);
    expect(tunnel1).toHaveLength(1);

    // Simulate WS reconnect — new tunnel, fresh send callback.
    coord.bind({ send: (frame) => { tunnel2.push(frame); } });

    // Approved set survives — controller would have to re-replay anyway,
    // but the gate must not flap (would cause manifest tools to vanish
    // briefly until replay).
    expect(coord.isApproved("crm")).toBe(true);

    // New frames go to the new tunnel only.
    coord.emitDiscovered({ mcp: "crm", author: "customer", source: "dropin", envKeys: [], tools: [] });
    expect(tunnel2).toHaveLength(1);
    expect(tunnel1).toHaveLength(1); // unchanged from before bind
  });
});

// Wire-frame shape regressions: the discriminator names are part of the
// contract with the controller. A typo here would silently fail the round-
// trip without breaking the build.
describe("ApprovalCoordinator — wire frame discriminators", () => {
  it("emits frames whose `type` values match the protocol", async () => {
    const fake = buildSupervisor([localStatus("crm", 1)]);
    const { coord, sent } = buildCoord({ fakeSupervisor: fake });

    coord.emitDiscovered({ mcp: "crm", author: "customer", source: "dropin", envKeys: [], tools: [] });
    await coord.handleEnable({ type: "mcp-enable", mcp: "crm" });
    await coord.handleDisable({ type: "mcp-disable", mcp: "crm" });

    expect(sent.map((f) => f.type)).toEqual([
      "mcp-discovered",
      "mcp-enable-ack",
      "mcp-enable-ack",
    ]);
  });

  // Negative test: ensure the frame-typed inputs don't accidentally widen
  // to `any` — TS compile-time check: McpEnableFrame literal members.
  it("accepts only the documented `mcp-enable` shape", async () => {
    const fake = buildSupervisor([localStatus("crm", 0)]);
    const { coord } = buildCoord({ fakeSupervisor: fake });
    const enable: McpEnableFrame = { type: "mcp-enable", mcp: "crm" };
    const disable: McpDisableFrame = { type: "mcp-disable", mcp: "crm" };
    await coord.handleEnable(enable);
    await coord.handleDisable(disable);
    expect(coord.isApproved("crm")).toBe(false);
  });
});
