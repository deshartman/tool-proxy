import { describe, it, expect } from "vitest";

import { Dispatcher } from "@connector/dispatcher.js";
import { bareNaming, qualifiedNaming, negotiateNaming, type WireNaming } from "@connector/tunnel/naming.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { TunnelClient } from "@connector/tunnel/client.js";
import type { TunnelFrame, ToolManifest } from "@connector/tunnel/frames.js";

// MULTI-PLATFORM-MCP Phase 2b. Tool and prompt names on the wire depend on the
// session's negotiated major: bare `<server>.<name>` under 1.x, qualified
// `<proxyId>.<server>.<name>` under 2.x. The Dispatcher is handed ONE naming per
// session and never branches on a version itself. Pinned here: both forms
// list and dispatch correctly, the 2.x parse keeps dots in the tool name, and a
// name addressed to ANOTHER proxy is refused exactly like an unknown server.

const PROXY = "cra85py8";
const OTHER = "k3f9x2qa";

class FakeTunnel {
  onframe?: (frame: unknown) => void;
  sent: TunnelFrame[] = [];
  send(frame: TunnelFrame): void { this.sent.push(frame); }
}

const config = {
  mcp_servers: [],
  policy: { max_concurrent_calls: 4, log_tool_args: false, tool_timeout_ms: 1000, heartbeat_interval_ms: 1000, reconnect: { enabled: false } },
} as unknown as ConnectorConfig;

function stub(name: string, calls: string[]): McpServerConnection {
  return {
    name,
    transport: "http",
    capabilities: { prompts: {} },
    listTools: async () => [],
    callTool: async (tool: string) => { calls.push(`${name}:${tool}`); return { content: [] }; },
    listPrompts: async () => [{ name: "brief" }],
    getPrompt: async (prompt: string) => { calls.push(`${name}:prompt:${prompt}`); return { messages: [] }; },
    listResources: async () => [],
    listResourceTemplates: async () => [],
    onNotification: () => () => undefined,
    close: async () => undefined,
  } as unknown as McpServerConnection;
}

const manifest: ToolManifest = {
  connectorId: "",
  environment: "dev",
  version: "dev",
  servers: [
    {
      name: "crm",
      transport: "http",
      author: "customer",
      tools: [
        { name: "get_customer", description: "d", inputSchema: {}, allowed: true },
        { name: "get.by.phone", description: "dotted", inputSchema: {}, allowed: true },
      ],
    },
  ],
};

function setup(naming: WireNaming) {
  const tunnel = new FakeTunnel();
  const calls: string[] = [];
  const logs: string[] = [];
  new Dispatcher({
    config,
    servers: new Map([["crm", stub("crm", calls)]]),
    getManifest: () => manifest,
    tunnel: tunnel as unknown as TunnelClient,
    log: (line) => logs.push(line),
    naming,
  }).attach();
  const rpc = async (method: string, params: Record<string, unknown>) => {
    tunnel.sent = [];
    tunnel.onframe?.({ type: "rpc", payload: { jsonrpc: "2.0", id: "r", method, params } });
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    return (tunnel.sent[0] as { payload: { result?: Record<string, unknown>; error?: { code: number; message: string; data?: { kind?: string } } } }).payload;
  };
  return { rpc, calls, logs };
}

describe("1.x — bare names (unchanged)", () => {
  it("lists and dispatches <server>.<tool>", async () => {
    const { rpc, calls } = setup(bareNaming());
    const list = (await rpc("tools/list", {})).result as { tools: Array<{ name: string }> };
    expect(list.tools.map((t) => t.name)).toEqual(["crm.get_customer", "crm.get.by.phone"]);
    await rpc("tools/call", { name: "crm.get_customer", arguments: {} });
    expect(calls).toEqual(["crm:get_customer"]);
  });
});

describe("2.x — qualified names", () => {
  it("lists every tool as <proxyId>.<server>.<tool>", async () => {
    const { rpc } = setup(qualifiedNaming(PROXY));
    const list = (await rpc("tools/list", {})).result as { tools: Array<{ name: string }> };
    expect(list.tools.map((t) => t.name)).toEqual([`${PROXY}.crm.get_customer`, `${PROXY}.crm.get.by.phone`]);
  });

  it("dispatches a qualified name to the right server and tool", async () => {
    const { rpc, calls } = setup(qualifiedNaming(PROXY));
    const reply = await rpc("tools/call", { name: `${PROXY}.crm.get_customer`, arguments: {} });
    expect(reply.error).toBeUndefined();
    expect(calls).toEqual(["crm:get_customer"]);
  });

  it("keeps further dots in the TOOL name (the two-step parse)", async () => {
    const { rpc, calls } = setup(qualifiedNaming(PROXY));
    await rpc("tools/call", { name: `${PROXY}.crm.get.by.phone`, arguments: {} });
    expect(calls).toEqual(["crm:get.by.phone"]);
  });

  it("refuses a name addressed to ANOTHER proxy — same reply as an unknown server, and logged", async () => {
    const { rpc, calls, logs } = setup(qualifiedNaming(PROXY));
    const foreign = await rpc("tools/call", { name: `${OTHER}.crm.get_customer`, arguments: {} });
    const unknown = await rpc("tools/call", { name: `${PROXY}.nope.get_customer`, arguments: {} });
    expect(calls).toEqual([]);
    expect(foreign.error?.data?.kind).toBe("tool_not_found");
    expect(foreign.error?.data?.kind).toBe(unknown.error?.data?.kind); // no existence oracle
    expect(logs.some((l) => l.includes(OTHER) && l.includes("not this proxy"))).toBe(true);
  });

  it("refuses the 1.x bare form once the session is 2.x (no shape-guessing)", async () => {
    const { rpc, calls } = setup(qualifiedNaming(PROXY));
    const reply = await rpc("tools/call", { name: "crm.get_customer", arguments: {} });
    expect(calls).toEqual([]);
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain("${proxyId}.${server}.${tool}");
  });

  it("qualifies prompt names the same way", async () => {
    const { rpc, calls } = setup(qualifiedNaming(PROXY));
    const list = (await rpc("prompts/list", {})).result as { prompts: Array<{ name: string }> };
    expect(list.prompts.map((p) => p.name)).toEqual([`${PROXY}.crm.brief`]);
    await rpc("prompts/get", { name: `${PROXY}.crm.brief`, arguments: {} });
    expect(calls).toEqual(["crm:prompt:brief"]);
  });
});

// The cross-version compatibility matrix. The session major is
// min(what the proxy will speak, what the controller advertised); a controller
// that predates supportedTunnelProtocol advertises nothing and is 1.x.
describe("negotiateNaming — the version matrix", () => {
  const cases: Array<[string, number, { major: number } | undefined, 1 | 2]> = [
    ["1.x proxy, 1.x controller (silent)",   1, undefined,     1],
    ["1.x proxy, 1.x controller (says 1)",   1, { major: 1 },  1],
    ["1.x proxy, 2.x controller",            1, { major: 2 },  1],
    ["2.x proxy, 1.x controller (silent)",   2, undefined,     1],
    ["2.x proxy, 1.x controller (says 1)",   2, { major: 1 },  1],
    ["2.x proxy, 2.x controller",            2, { major: 2 },  2],
  ];
  it.each(cases)("%s → major %s", (_label, speak, controller, expected) => {
    const naming = negotiateNaming(speak, controller, PROXY);
    expect(naming.major).toBe(expected);
    // And the form matches the major — the two can never disagree.
    expect(naming.compose("crm", "t")).toBe(expected === 2 ? `${PROXY}.crm.t` : "crm.t");
  });

  it("only BOTH sides on 2 produces qualified names (no one-sided upgrade)", () => {
    const qualified = cases.filter(([, s, c]) => negotiateNaming(s, c, PROXY).major === 2);
    expect(qualified.map(([label]) => label)).toEqual(["2.x proxy, 2.x controller"]);
  });
});
