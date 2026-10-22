import { describe, it, expect } from "vitest";

import { Dispatcher } from "@connector/dispatcher.js";
import { qualifiedNaming, type WireNaming } from "@connector/tunnel/naming.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { TunnelClient } from "@connector/tunnel/client.js";
import type { TunnelFrame, ToolManifest } from "@connector/tunnel/frames.js";

// Tool and prompt names on the wire are `<proxyId>.<server>.<name>` (protocol
// 3.x only; the 1.x bare and 2.x forms are gone). Pinned here: names list and
// dispatch, the parse keeps dots in the tool name, a name addressed to ANOTHER
// proxy is refused exactly like an unknown server, and a bare name is -32602.

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

describe("3.x — qualified names", () => {
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

  it("refuses the bare form (no shape-guessing) (no shape-guessing)", async () => {
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
