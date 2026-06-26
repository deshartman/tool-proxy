import { describe, it, expect, vi } from "vitest";

import { announceDiscoveredDropins } from "../../src/boot/announce-dropins.js";
import { ApprovalCoordinator } from "../../src/tunnel/approval-coordinator.js";
import type { McpServerConnection } from "../../src/servers/index.js";
import type { McpStatus, McpSupervisor } from "../../src/mcp-supervisor.js";
import type { Logger } from "../../src/logger.js";
import type { McpDiscoveredFrame, TunnelFrame } from "../../src/tunnel/frames.js";

// Manual finding 2026-06-26: inspector showed `sample` as Orphaned and
// `crm` as Live after a fresh reconnect, even though both were approved
// on the controller. Boot log: `mcp-discovered fan-out complete announced:
// 1, totalDropins: 2`. Root cause: the boot fan-out checked
// `approval.isApproved(name)` inside the loop. While the first iteration
// was suspended at `await fetchEnvKeys(...)`, the controller's replayed
// mcp-enable frames landed synchronously on the WS router and populated
// the approved set for BOTH drop-ins. The second iteration's gate then
// returned true and skipped the emit, leaving sample without a presence
// signal for the controller's Live/Orphaned classification.
//
// The fix removes the mid-loop gate. These tests pin the new behaviour:
// every drop-in gets announced even when its approval flips mid-loop.

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeConnection(name: string): McpServerConnection {
  return {
    name,
    transport: "http",
    listTools: async () => [
      { name: "tool_a", description: "a", inputSchema: { type: "object" } },
      { name: "tool_b", description: "b", inputSchema: { type: "object" } },
    ],
  } as unknown as McpServerConnection;
}

function localStatus(name: string): McpStatus {
  return {
    name,
    process: "running",
    credsSource: "none",
    restartCount: 0,
    toolsCount: 2,
    source: "local",
  };
}

function fakeSupervisor(names: string[], opts?: { onFetchEnvKeys?: (name: string) => Promise<void> }): McpSupervisor {
  const statuses = new Map(names.map((n) => [n, localStatus(n)]));
  return {
    statusList: () => [...statuses.values()],
    fetchEnvKeys: async (name: string) => {
      // Yield the event loop here so the test can interleave a synchronous
      // mcp-enable handler call between iterations of the fan-out loop —
      // this is the suspension point the production code awaits at.
      if (opts?.onFetchEnvKeys) await opts.onFetchEnvKeys(name);
      else await Promise.resolve();
      return [];
    },
    applyControllerEnv: async () => ({ applied: false, restarted: false }),
  } as unknown as McpSupervisor;
}

function discoveredFrames(sent: TunnelFrame[]): McpDiscoveredFrame[] {
  return sent.filter((f): f is McpDiscoveredFrame => f.type === "mcp-discovered");
}

describe("announceDiscoveredDropins", () => {
  it("emits mcp-discovered for every drop-in in the input list", async () => {
    const sent: TunnelFrame[] = [];
    const servers = new Map<string, McpServerConnection>([
      ["crm", fakeConnection("crm")],
      ["sample", fakeConnection("sample")],
    ]);
    const approval = new ApprovalCoordinator({
      send: (f) => sent.push(f),
      supervisor: fakeSupervisor(["crm", "sample"]),
      log: fakeLogger(),
      onManifestChange: () => {},
    });

    const result = await announceDiscoveredDropins({
      dropinNames: ["crm", "sample"],
      approval,
      supervisor: fakeSupervisor(["crm", "sample"]),
      servers,
      log: fakeLogger(),
    });

    expect(result).toEqual({ announced: 2, totalDropins: 2 });
    expect(discoveredFrames(sent).map((f) => f.mcp)).toEqual(["crm", "sample"]);
  });

  it("REGRESSION: announces every drop-in even when mcp-enable replay races mid-loop", async () => {
    // The shape of the bug: while iteration 1 is suspended at
    // `await fetchEnvKeys(...)`, the controller's replayed mcp-enable
    // frames land synchronously and populate the approved set for BOTH
    // drop-ins. A mid-loop `isApproved` gate would skip iteration 2.
    const sent: TunnelFrame[] = [];
    const servers = new Map<string, McpServerConnection>([
      ["crm", fakeConnection("crm")],
      ["sample", fakeConnection("sample")],
    ]);
    const approval = new ApprovalCoordinator({
      send: (f) => sent.push(f),
      supervisor: fakeSupervisor(["crm", "sample"]),
      log: fakeLogger(),
      onManifestChange: () => {},
    });

    // First-iteration suspension: when fetchEnvKeys("crm") yields, deliver
    // the controller's mcp-enable replay for BOTH drop-ins. This mirrors
    // the production log: handleEnable runs synchronously inside the
    // WS router callback, so by the time iter 1 resumes both names are
    // already in the approved set.
    let racedOnce = false;
    const supervisor = fakeSupervisor(["crm", "sample"], {
      onFetchEnvKeys: async (name) => {
        if (name === "crm" && !racedOnce) {
          racedOnce = true;
          await approval.handleEnable({ type: "mcp-enable", mcp: "crm" });
          await approval.handleEnable({ type: "mcp-enable", mcp: "sample" });
        }
      },
    });

    const result = await announceDiscoveredDropins({
      dropinNames: ["crm", "sample"],
      approval,
      supervisor,
      servers,
      log: fakeLogger(),
    });

    // Both drop-ins announced — sample did NOT get skipped despite being
    // flipped to approved mid-loop. This is the invariant the controller
    // depends on for Live (vs Orphaned) classification.
    expect(result.announced).toBe(2);
    expect(result.totalDropins).toBe(2);
    expect(discoveredFrames(sent).map((f) => f.mcp)).toEqual(["crm", "sample"]);
    // Both should have been pre-approved by the racing handleEnable calls
    // — sanity check that the race actually fired (not just that the loop
    // happened to work for an unrelated reason).
    expect(approval.isApproved("crm")).toBe(true);
    expect(approval.isApproved("sample")).toBe(true);
  });

  it("logs and continues when one drop-in's fetchEnvKeys throws", async () => {
    const sent: TunnelFrame[] = [];
    const log = fakeLogger();
    const servers = new Map<string, McpServerConnection>([
      ["crm", fakeConnection("crm")],
      ["sample", fakeConnection("sample")],
    ]);
    const approval = new ApprovalCoordinator({
      send: (f) => sent.push(f),
      supervisor: fakeSupervisor(["crm", "sample"]),
      log: fakeLogger(),
      onManifestChange: () => {},
    });

    const supervisor = {
      statusList: () => [localStatus("crm"), localStatus("sample")],
      fetchEnvKeys: async (name: string) => {
        if (name === "crm") throw new Error("envkeys boom");
        return [];
      },
    } as unknown as McpSupervisor;

    const result = await announceDiscoveredDropins({
      dropinNames: ["crm", "sample"],
      approval,
      supervisor,
      servers,
      log,
    });

    // crm's emit was skipped (its iteration threw); sample's still fired.
    expect(result.announced).toBe(1);
    expect(result.totalDropins).toBe(2);
    expect(discoveredFrames(sent).map((f) => f.mcp)).toEqual(["sample"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "crm" }),
      expect.stringContaining("mcp-discovered emission failed"),
    );
  });

  it("returns {announced: 0, totalDropins: 0} when there are no drop-ins", async () => {
    const sent: TunnelFrame[] = [];
    const approval = new ApprovalCoordinator({
      send: (f) => sent.push(f),
      supervisor: fakeSupervisor([]),
      log: fakeLogger(),
      onManifestChange: () => {},
    });

    const result = await announceDiscoveredDropins({
      dropinNames: [],
      approval,
      supervisor: fakeSupervisor([]),
      servers: new Map(),
      log: fakeLogger(),
    });

    expect(result).toEqual({ announced: 0, totalDropins: 0 });
    expect(sent).toHaveLength(0);
  });
});
