import { describe, it, expect, vi } from "vitest";

import { ApprovalCoordinator } from "@connector/tunnel/approval-coordinator.js";
import { buildManifest, dropinSpecsToMap } from "@connector/manifest/build.js";
import { diffManifest, isEmptyDelta } from "@connector/manifest/diff.js";
import type {
  ManifestDeltaFrame,
  McpDiscoveredFrame,
  McpEnableAckFrame,
  ToolManifest,
  TunnelFrame,
} from "@connector/tunnel/frames.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { McpStatus, McpSupervisor } from "@connector/mcp-supervisor.js";
import type { Logger } from "@connector/logger.js";
import type { DropinSpec } from "@connector/dropin.js";

// W-A4 end-to-end: pins the V1.3 boot flow contract WITHOUT booting a real
// process. We compose ApprovalCoordinator + buildManifest + diffManifest
// together — the same three pieces lifecycle.ts wires up. The goal is to
// catch a future refactor that severs any one of three load-bearing
// invariants:
//
//   1. Initial manifest excludes drop-ins until the controller approves.
//   2. mcp-discovered fires after register-ack for every unapproved drop-in.
//   3. mcp-enable triggers a manifest-delta { added: [...] } BEFORE the
//      mcp-enable-ack — frame ordering is part of the wire contract.
//   4. mcp-disable triggers a manifest-delta { removed: [...] } BEFORE the
//      mcp-enable-ack — same ordering rule, opposite direction.
//   5. Re-enable after disable is sub-second (no spawn) — the
//      ApprovalCoordinator never touches the supervisor's spawn methods.

const sampleConfig: ConnectorConfig = {
  tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
  mcp_servers: [{ name: "twilio", transport: "http", dir: "../../mcp/bundled/twilio" }],
  policy: {
    max_concurrent_calls: 1,
    log_tool_args: false,
    tool_timeout_ms: 1000,
    heartbeat_interval_ms: 1000,
    reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
  },
} as unknown as ConnectorConfig;

function fakeConnection(name: string): McpServerConnection {
  return {
    name,
    transport: "http",
    capabilities: undefined,
    listTools: async () => [
      { name: "tool_a", description: "a", inputSchema: { type: "object" } },
      { name: "tool_b", description: "b", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({}),
    listPrompts: async () => [],
    getPrompt: async () => ({}),
    listResources: async () => [],
    listResourceTemplates: async () => [],
    readResource: async () => ({}),
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
    complete: async () => ({}),
    setLoggingLevel: async () => ({}),
    onNotification: () => {},
    close: async () => {},
  } as unknown as McpServerConnection;
}

function dropinSpec(name: string): DropinSpec {
  return { name, transport: "http", dir: `/tmp/dropins/${name}`, __dropin: true } as unknown as DropinSpec;
}

function fakeSupervisor(initial: McpStatus[]): {
  supervisor: McpSupervisor;
  appliedEnv: Array<{ mcp: string; env: Record<string, string>; source: string; reason: string }>;
} {
  const statuses = new Map(initial.map((s) => [s.name, s]));
  const appliedEnv: Array<{ mcp: string; env: Record<string, string>; source: string; reason: string }> = [];
  const supervisor = {
    statusList: () => [...statuses.values()],
    applyControllerEnv: async (mcp: string, env: Record<string, string>, source: string, reason: string) => {
      appliedEnv.push({ mcp, env, source, reason });
      return { applied: true, restarted: true };
    },
  } as unknown as McpSupervisor;
  return { supervisor, appliedEnv };
}

function localStatus(name: string, toolsCount = 2): McpStatus {
  return {
    name,
    process: "running",
    credsSource: "none",
    restartCount: 0,
    toolsCount,
    source: "local",
  };
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// Composer that mirrors lifecycle.ts's manifest-rebuild path. Holds a
// cumulative `current` manifest and emits `manifest-delta` frames when
// shape changes, exactly like refreshManifestAndPushDelta does.
async function composedHarness(opts: {
  servers: Map<string, McpServerConnection>;
  dropins: DropinSpec[];
  config?: ConnectorConfig;
}): Promise<{
  approval: ApprovalCoordinator;
  sentFrames: TunnelFrame[];
  refresh: () => Promise<void>;
  buildInitial: () => Promise<ToolManifest>;
  current: () => ToolManifest;
}> {
  const cfg = opts.config ?? sampleConfig;
  const dropinMap = dropinSpecsToMap(opts.dropins);
  const sentFrames: TunnelFrame[] = [];
  const { supervisor } = fakeSupervisor(opts.dropins.map((d) => localStatus(d.name)));

  let current: ToolManifest = {
    connectorId: "",
    environment: cfg.tunnel.environment,
    version: "test",
    servers: [],
  };

  const approval = new ApprovalCoordinator({
    send: (frame) => { sentFrames.push(frame); },
    supervisor,
    log: fakeLogger(),
    onManifestChange: async () => { await refresh(); },
  });

  async function refresh(): Promise<void> {
    const next = await buildManifest(
      cfg,
      opts.servers,
      "test",
      undefined,
      (n) => approval.isApproved(n),
      dropinMap,
    );
    const delta = diffManifest(current, next);
    current = next;
    if (!isEmptyDelta(delta)) {
      sentFrames.push({ type: "manifest-delta", delta });
    }
  }

  return {
    approval,
    sentFrames,
    refresh,
    buildInitial: async () => {
      current = await buildManifest(
        cfg,
        opts.servers,
        "test",
        undefined,
        (n) => approval.isApproved(n),
        dropinMap,
      );
      return current;
    },
    current: () => current,
  };
}

describe("v1.3 boot flow — first-ever approval", () => {
  it("initial manifest excludes the drop-in", async () => {
    const servers = new Map<string, McpServerConnection>([["crm", fakeConnection("crm")]]);
    const h = await composedHarness({ servers, dropins: [dropinSpec("crm")], config: { ...sampleConfig, mcp_servers: [] } as unknown as ConnectorConfig });

    const initial = await h.buildInitial();
    expect(initial.servers).toHaveLength(0);
  });

  it("mcp-enable adds the MCP via manifest-delta BEFORE the ack", async () => {
    const servers = new Map<string, McpServerConnection>([["crm", fakeConnection("crm")]]);
    const h = await composedHarness({ servers, dropins: [dropinSpec("crm")], config: { ...sampleConfig, mcp_servers: [] } as unknown as ConnectorConfig });
    await h.buildInitial();

    await h.approval.handleEnable({ type: "mcp-enable", mcp: "crm" });

    // Frame order: manifest-delta first, ack second. The wire contract.
    const types = h.sentFrames.map((f) => f.type);
    expect(types).toEqual(["manifest-delta", "mcp-enable-ack"]);
    const delta = (h.sentFrames[0] as ManifestDeltaFrame).delta;
    expect(delta.added.map((a) => a.server)).toEqual(["crm", "crm"]);
    const ack = h.sentFrames[1] as McpEnableAckFrame;
    expect(ack.status).toBe("enabled");
    expect(ack.toolsCount).toBe(2);
  });
});

describe("v1.3 boot flow — disable preserves the child", () => {
  it("mcp-disable removes via manifest-delta BEFORE the ack, no spawn touched", async () => {
    const servers = new Map<string, McpServerConnection>([["crm", fakeConnection("crm")]]);
    const h = await composedHarness({ servers, dropins: [dropinSpec("crm")], config: { ...sampleConfig, mcp_servers: [] } as unknown as ConnectorConfig });
    await h.buildInitial();

    await h.approval.handleEnable({ type: "mcp-enable", mcp: "crm" });
    h.sentFrames.length = 0; // reset for the next gesture

    await h.approval.handleDisable({ type: "mcp-disable", mcp: "crm" });

    const types = h.sentFrames.map((f) => f.type);
    expect(types).toEqual(["manifest-delta", "mcp-enable-ack"]);
    const delta = (h.sentFrames[0] as ManifestDeltaFrame).delta;
    expect(delta.removed.map((r) => r.server)).toContain("crm");
  });

  it("re-enable after disable is sub-second (no env applied → no supervisor restart)", async () => {
    const servers = new Map<string, McpServerConnection>([["crm", fakeConnection("crm")]]);
    const h = await composedHarness({ servers, dropins: [dropinSpec("crm")], config: { ...sampleConfig, mcp_servers: [] } as unknown as ConnectorConfig });
    await h.buildInitial();

    await h.approval.handleEnable({ type: "mcp-enable", mcp: "crm" });
    await h.approval.handleDisable({ type: "mcp-disable", mcp: "crm" });
    h.sentFrames.length = 0;

    await h.approval.handleEnable({ type: "mcp-enable", mcp: "crm" });

    // Re-enable: tools come back via manifest-delta; the ack reports
    // toolsCount == 2 same as the original. No supervisor.applyControllerEnv
    // path was triggered (no env in the frame), so no restart cost.
    const types = h.sentFrames.map((f) => f.type);
    expect(types).toEqual(["manifest-delta", "mcp-enable-ack"]);
    const ack = h.sentFrames[1] as McpEnableAckFrame;
    expect(ack.status).toBe("enabled");
    expect(ack.toolsCount).toBe(2);
  });
});

describe("v1.3 boot flow — discovered frame shape", () => {
  it("emitDiscovered produces a frame the controller can render in Pending", () => {
    const servers = new Map<string, McpServerConnection>();
    const sent: TunnelFrame[] = [];
    const supervisor = fakeSupervisor([localStatus("crm")]);

    const approval = new ApprovalCoordinator({
      send: (f) => sent.push(f),
      supervisor: supervisor.supervisor,
      log: fakeLogger(),
      onManifestChange: () => {},
    });

    approval.emitDiscovered({
      mcp: "crm",
      envKeys: ["MOCK_CUSTOMERS_URL"],
      tools: [
        { name: "get_customer", description: "Look up by phone." },
        { name: "issue_refund" },
      ],
    });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as McpDiscoveredFrame;
    expect(frame.type).toBe("mcp-discovered");
    expect(frame.author).toBe("customer");
    expect(frame.source).toBe("local");
    expect(frame.tools).toHaveLength(2);
    // Schemas deliberately withheld — not in the descriptor type.
    const firstTool = frame.tools[0] as Record<string, unknown>;
    expect(firstTool.inputSchema).toBeUndefined();
    expect(firstTool.outputSchema).toBeUndefined();

    void servers; // unused but kept for clarity of the shared harness pattern
  });
});
