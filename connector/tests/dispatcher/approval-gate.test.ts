import { qualifiedNaming } from "@connector/tunnel/naming.js";
import { describe, it, expect, vi } from "vitest";

import { Dispatcher } from "@connector/dispatcher.js";
import { ApprovalCoordinator } from "@connector/tunnel/approval-coordinator.js";
import { WebhookRegistry } from "@connector/tunnel/webhook-registry.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { TunnelClient } from "@connector/tunnel/client.js";
import type { TunnelFrame, WebhookFrame } from "@connector/tunnel/frames.js";
import type { McpSupervisor } from "@connector/mcp-supervisor.js";
import type { Logger } from "@connector/logger.js";

const PROXY = "cra85py8";

// The tunnel dispatcher used to check only that a server EXISTED
// (servers.get), never that the controller had approved it. The manifest
// withholds an unapproved drop-in, but a controller naming it directly in a
// tools/call still reached it — and the aggregate prompts/list and
// resources/list iterated the raw servers map, so an unapproved drop-in's
// prompts and resources leaked into those lists too. With one controller
// that is the same party that approves, so it was latent; with several
// controllers it lets one reach an MCP only another enabled.
//
// Pinned here:
//   * every per-server route treats an unapproved server as absent;
//   * aggregate list methods skip it;
//   * enable lets it through, disable shuts it again;
//   * un-gated servers are unaffected;
//   * webhook DELIVERY is gated, but subscribe is not (a child subscribes at
//     spawn, before approval — refusing there breaks it at boot).

class FakeTunnel {
  onframe?: (frame: unknown) => void;
  sent: TunnelFrame[] = [];
  send(frame: TunnelFrame): void { this.sent.push(frame); }
}

function stubConnection(name: string, calls: string[]): McpServerConnection {
  const record = (method: string) => async () => { calls.push(`${name}:${method}`); return {}; };
  return {
    name,
    transport: "http",
    capabilities: { prompts: {}, resources: {} },
    listTools: async () => [],
    callTool: record("callTool"),
    listPrompts: async () => [{ name: "p" }],
    getPrompt: record("getPrompt"),
    listResources: async () => [{ uri: `${name}://r`, name: "r" }],
    listResourceTemplates: async () => [],
    readResource: record("readResource"),
    subscribeResource: record("subscribeResource"),
    unsubscribeResource: record("unsubscribeResource"),
    complete: record("complete"),
    setLoggingLevel: record("setLoggingLevel"),
    onNotification: () => () => undefined,
    close: async () => undefined,
  } as unknown as McpServerConnection;
}

function makeConfig(): ConnectorConfig {
  return {
    mcp_servers: [],
    policy: {
      max_concurrent_calls: 4,
      log_tool_args: false,
      tool_timeout_ms: 1000,
      heartbeat_interval_ms: 1000,
      reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
    },
  } as unknown as ConnectorConfig;
}

function fakeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// "dropin" is gated, "bundled" is not. `approved` is the controller's say.
function setup(approved: Set<string>) {
  const tunnel = new FakeTunnel();
  const calls: string[] = [];
  const servers = new Map<string, McpServerConnection>([
    ["dropin", stubConnection("dropin", calls)],
    ["bundled", stubConnection("bundled", calls)],
  ]);
  const gated = new Set(["dropin"]);
  new Dispatcher({
    config: makeConfig(),
    servers,
    getManifest: () => ({ connectorId: "", environment: "test", version: "test", servers: [] }),
    tunnel: tunnel as unknown as TunnelClient,
    log: () => undefined,
    isServerEnabled: (name) => !gated.has(name) || approved.has(name),
    naming: qualifiedNaming(PROXY),
  }).attach();

  const rpc = async (method: string, params: Record<string, unknown>) => {
    tunnel.sent = [];
    tunnel.onframe?.({ type: "rpc", payload: { jsonrpc: "2.0", id: "r1", method, params } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return (tunnel.sent[0] as { payload: { result?: Record<string, unknown>; error?: { data?: { kind?: string } } } }).payload;
  };
  return { rpc, calls };
}

const PER_SERVER_ROUTES: Array<[string, Record<string, unknown>]> = [
  ["tools/call", { name: `${PROXY}.dropin.t`, arguments: {} }],
  ["prompts/get", { name: `${PROXY}.dropin.p`, arguments: {} }],
  ["resources/read", { uri: "dropin://r", serverName: "dropin" }],
  ["resources/read", { uri: "dropin://r" }], // scheme fallback
  ["resources/subscribe", { uri: "dropin://r", serverName: "dropin" }],
  ["completion/complete", { serverName: "dropin", ref: {}, argument: {} }],
  ["logging/setLevel", { serverName: "dropin", level: "info" }],
];

describe("Dispatcher — approval gate", () => {
  it.each(PER_SERVER_ROUTES)("refuses %s for an unapproved gated server without reaching it", async (method, params) => {
    const { rpc, calls } = setup(new Set());
    const reply = await rpc(method, params);
    expect(reply.error).toBeDefined();
    expect(reply.result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("replies the same kind an absent server gets (no existence oracle)", async () => {
    const { rpc } = setup(new Set());
    const gatedReply = await rpc("tools/call", { name: `${PROXY}.dropin.t`, arguments: {} });
    const absentReply = await rpc("tools/call", { name: `${PROXY}.nope.t`, arguments: {} });
    expect(gatedReply.error?.data?.kind).toBe(absentReply.error?.data?.kind);
  });

  it.each(PER_SERVER_ROUTES)("allows %s once the server is approved", async (method, params) => {
    const { rpc, calls } = setup(new Set(["dropin"]));
    const reply = await rpc(method, params);
    expect(reply.error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("leaves un-gated servers reachable while the gated one is not approved", async () => {
    const { rpc, calls } = setup(new Set());
    const reply = await rpc("tools/call", { name: `${PROXY}.bundled.t`, arguments: {} });
    expect(reply.error).toBeUndefined();
    expect(calls).toEqual(["bundled:callTool"]);
  });

  it("omits an unapproved server from aggregate prompts/list and resources/list", async () => {
    const { rpc } = setup(new Set());
    const prompts = (await rpc("prompts/list", {})).result as { prompts: Array<{ name: string }> };
    expect(prompts.prompts.map((p) => p.name)).toEqual([`${PROXY}.bundled.p`]);
    const resources = (await rpc("resources/list", {})).result as { resources: Array<{ uri: string }> };
    expect(resources.resources.map((r) => r.uri)).toEqual(["bundled://r"]);
  });

  it("treats a narrowed list on an unapproved server as server_not_found", async () => {
    const { rpc } = setup(new Set());
    const reply = await rpc("prompts/list", { serverName: "dropin" });
    expect(reply.error?.data?.kind).toBe("server_not_found");
  });
});

describe("ApprovalCoordinator.isEnabled", () => {
  function coord(): ApprovalCoordinator {
    const supervisor = {
      statusList: () => [{ name: "dropin", source: "local" }],
      applyControllerEnv: async () => ({ applied: true, restarted: false }),
    } as unknown as McpSupervisor;
    return new ApprovalCoordinator({ send: () => undefined, supervisor, log: fakeLog(), onManifestChange: () => undefined });
  }
  const isGated = (name: string) => name === "dropin";

  it("is true for un-gated servers regardless of approval", () => {
    expect(coord().isEnabled("bundled", isGated)).toBe(true);
  });

  it("follows mcp-enable and mcp-disable for gated servers", async () => {
    const c = coord();
    expect(c.isEnabled("dropin", isGated)).toBe(false);
    await c.handleEnable({ type: "mcp-enable", mcp: "dropin" });
    expect(c.isEnabled("dropin", isGated)).toBe(true);
    await c.handleDisable({ type: "mcp-disable", mcp: "dropin" });
    expect(c.isEnabled("dropin", isGated)).toBe(false);
  });
});

describe("WebhookRegistry — delivery is gated, subscribe is not", () => {
  function registry(enabled: Set<string>) {
    const sent: unknown[] = [];
    const reg = new WebhookRegistry({
      sendFrame: (frame) => { sent.push(frame); return true; },
      allocateTimeoutMs: 1000,
      isMcpEnabled: (mcp) => enabled.has(mcp),
      log: fakeLog(),
    });
    reg.setTunnelOpen(true);
    return { reg, sent };
  }
  const frame: WebhookFrame = {
    type: "webhook",
    mcp: "dropin",
    body: "x",
    queryParameters: {},
    headers: {},
    receivedAt: new Date().toISOString(),
  } as unknown as WebhookFrame;

  it("lets an unapproved MCP subscribe (it does so at spawn) but delivers nothing", async () => {
    const { reg } = registry(new Set());
    const listener = vi.fn();
    const pending = reg.subscribe("dropin", listener);
    reg.onAllocateAck({ type: "webhook-allocate-ack", mcp: "dropin", url: "https://c/x" } as never);
    await expect(pending).resolves.toMatchObject({ url: "https://c/x" });
    reg.dispatch(frame);
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers once the MCP is enabled", async () => {
    const enabled = new Set<string>();
    const { reg } = registry(enabled);
    const listener = vi.fn();
    const pending = reg.subscribe("dropin", listener);
    reg.onAllocateAck({ type: "webhook-allocate-ack", mcp: "dropin", url: "https://c/x" } as never);
    await pending;
    enabled.add("dropin");
    reg.dispatch(frame);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
