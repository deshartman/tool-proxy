import { describe, it, expect } from "vitest";

import { Dispatcher } from "@connector/dispatcher.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { TunnelClient } from "@connector/tunnel/client.js";
import type { TunnelFrame } from "@connector/tunnel/frames.js";

// Pins the mcp_disconnected log-hint added post-CODE-HYGINE (finding #2).
// When a tools/call awaits a reply and its target MCP is removed from the
// servers map mid-flight, the dispatcher classifies the failure as
// mcp_disconnected. Prior to this change the log line was identical
// whether the MCP was mid-restart or truly gone, which is noisy — the
// operator's mental model separates "restarting" (retry) from "gone"
// (investigate).
//
// Reply-kind semantics unchanged; log-line only.

class FakeTunnel {
  onframe?: (frame: unknown) => void;
  sent: TunnelFrame[] = [];
  send(frame: TunnelFrame): void { this.sent.push(frame); }
}

function unused(): never { throw new Error("unused"); }

function stubConnection(name: string, callToolBehavior: () => Promise<unknown>): McpServerConnection {
  return {
    name,
    transport: "http",
    listTools: async () => [],
    callTool: async () => callToolBehavior(),
    listPrompts: async () => [],
    getPrompt: unused,
    listResources: async () => [],
    listResourceTemplates: async () => [],
    readResource: unused,
    subscribeResource: unused,
    unsubscribeResource: unused,
    complete: unused,
    setLoggingLevel: unused,
    onNotification: () => () => undefined,
    close: async () => undefined,
  };
}

function makeConfig(): ConnectorConfig {
  return {
    tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
    mcp_servers: [{ name: "flaky", transport: "http" }],
    policy: {
      max_concurrent_calls: 4,
      log_tool_args: false,
      tool_timeout_ms: 1000,
      heartbeat_interval_ms: 1000,
      reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
    },
  } as unknown as ConnectorConfig;
}

async function driveDispatchAndCaptureLog(opts: {
  removeMidCall: boolean;
  isRestarting?: (name: string) => boolean;
}): Promise<string[]> {
  const tunnel = new FakeTunnel();
  const servers = new Map<string, McpServerConnection>();
  const conn = stubConnection("flaky", async () => {
    // Simulate the supervisor closing the connection while the call is in
    // flight: remove from the map before the SDK's error propagates.
    if (opts.removeMidCall) servers.delete("flaky");
    throw new Error("connection closed");
  });
  servers.set("flaky", conn);

  const logLines: string[] = [];
  new Dispatcher({
    config: makeConfig(),
    servers,
    getManifest: () => ({ connectorId: "", environment: "test", version: "test", servers: [] }),
    tunnel: tunnel as unknown as TunnelClient,
    log: (line) => logLines.push(line),
    isRestarting: opts.isRestarting,
  }).attach();

  const rpcFrame: TunnelFrame = {
    type: "rpc",
    payload: {
      jsonrpc: "2.0",
      id: "req1",
      method: "tools/call",
      params: { name: "flaky.echo", arguments: {} },
    },
  } as TunnelFrame;
  tunnel.onframe?.(rpcFrame);
  // Yield until the dispatcher's async catch has run.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return logLines;
}

describe("Dispatcher — restart-in-progress log hint (finding #2)", () => {
  it("mid-restart failure (isRestarting=true) appends the hint", async () => {
    const lines = await driveDispatchAndCaptureLog({
      removeMidCall: true,
      isRestarting: () => true,
    });
    const failLine = lines.find((l) => l.includes("failed"));
    expect(failLine).toBeDefined();
    expect(failLine).toContain("mcp_disconnected");
    expect(failLine).toContain("restart in progress");
  });

  it("truly-gone failure (isRestarting=false) omits the hint", async () => {
    const lines = await driveDispatchAndCaptureLog({
      removeMidCall: true,
      isRestarting: () => false,
    });
    const failLine = lines.find((l) => l.includes("failed"));
    expect(failLine).toBeDefined();
    expect(failLine).toContain("mcp_disconnected");
    expect(failLine).not.toContain("restart in progress");
  });

  it("absent isRestarting callback (pre-2026-07-28 behavior) omits the hint", async () => {
    const lines = await driveDispatchAndCaptureLog({
      removeMidCall: true,
      // isRestarting omitted — dispatcher must not throw and must not append hint.
    });
    const failLine = lines.find((l) => l.includes("failed"));
    expect(failLine).toBeDefined();
    expect(failLine).toContain("mcp_disconnected");
    expect(failLine).not.toContain("restart in progress");
  });

  it("failure without map-removal (tool_failed) never appends the hint even with isRestarting=true", async () => {
    const lines = await driveDispatchAndCaptureLog({
      removeMidCall: false,
      isRestarting: () => true,
    });
    const failLine = lines.find((l) => l.includes("failed"));
    expect(failLine).toBeDefined();
    // The reply kind branch stayed on "tool_failed" (connection still in map)
    // — the hint is scoped to the mcp_disconnected branch only.
    expect(failLine).toContain("tool_failed");
    expect(failLine).not.toContain("restart in progress");
  });
});
