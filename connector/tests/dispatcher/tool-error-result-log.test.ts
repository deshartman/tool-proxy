import { describe, it, expect } from "vitest";

import { Dispatcher } from "@connector/dispatcher.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { TunnelClient } from "@connector/tunnel/client.js";
import type { TunnelFrame } from "@connector/tunnel/frames.js";

// Surfaced 2026-08-14 while answering a controller-side session about a voice
// procedure. A child MCP that rejects its arguments does NOT throw: the MCP SDK
// catches validation failures and returns a successful JSON-RPC result carrying
// `isError: true`. The dispatcher relayed that verbatim (correct) but logged it
// as `tools/call <name> ok` (misleading) — so a rejected call was
// indistinguishable from a successful one in the only durable record the
// connector produces. The result payload lives only in the in-memory message
// tap, which is capped and cleared on restart.
//
// Two things are pinned here, and the second matters more than the first:
//   1. An isError result logs `tool-error` rather than `ok`.
//   2. Wire semantics are UNCHANGED — the reply is still a JSON-RPC `result`
//      with isError intact, never an error frame. Tool-level errors are meant
//      to reach the controller's model, which reads the message and adapts.
//      Converting them to -32010/tool_failed would collapse the distinction
//      between "the tool ran and rejected the input" and "the transport died".

class FakeTunnel {
  onframe?: (frame: unknown) => void;
  sent: TunnelFrame[] = [];
  send(frame: TunnelFrame): void { this.sent.push(frame); }
}

function unused(): never { throw new Error("unused"); }

function stubConnection(name: string, result: unknown): McpServerConnection {
  return {
    name,
    transport: "http",
    listTools: async () => [],
    callTool: async () => result,
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

async function dispatch(result: unknown): Promise<{ logLines: string[]; sent: TunnelFrame[] }> {
  const tunnel = new FakeTunnel();
  const servers = new Map<string, McpServerConnection>();
  servers.set("flaky", stubConnection("flaky", result));

  const logLines: string[] = [];
  new Dispatcher({
    config: makeConfig(),
    servers,
    getManifest: () => ({ connectorId: "", environment: "test", version: "test", servers: [] }),
    tunnel: tunnel as unknown as TunnelClient,
    log: (line) => logLines.push(line),
  }).attach();

  tunnel.onframe?.({
    type: "rpc",
    payload: {
      jsonrpc: "2.0",
      id: "req1",
      method: "tools/call",
      params: { name: "flaky.echo", arguments: {} },
    },
  } as TunnelFrame);
  // Yield until the dispatcher's async path has run.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return { logLines, sent: tunnel.sent };
}

const ZOD_REJECTION = {
  content: [{ type: "text", text: "Input validation error: Invalid arguments for tool echo" }],
  isError: true,
};

function outcomeLine(logLines: string[]): string | undefined {
  // The dispatcher emits an args line first, then the outcome line.
  return logLines.find((l) => l.includes("flaky.echo") && !l.includes("args="));
}

describe("Dispatcher — tool-level isError result is logged distinctly", () => {
  it("logs tool-error (not ok) when the child returns isError: true", async () => {
    const { logLines } = await dispatch(ZOD_REJECTION);
    const line = outcomeLine(logLines);
    expect(line).toBeDefined();
    expect(line).toContain("tool-error");
    // The whole point: the old behavior said "ok" here.
    expect(line).not.toMatch(/\bok\b/);
  });

  it("still logs ok for a genuine success", async () => {
    const { logLines } = await dispatch({ content: [{ type: "text", text: "hi" }] });
    const line = outcomeLine(logLines);
    expect(line).toContain("ok");
    expect(line).not.toContain("tool-error");
  });

  it("treats isError: false as ok", async () => {
    const { logLines } = await dispatch({ content: [], isError: false });
    const line = outcomeLine(logLines);
    expect(line).toContain("ok");
    expect(line).not.toContain("tool-error");
  });

  it("relays the isError result verbatim as a JSON-RPC result, not an error", async () => {
    const { sent } = await dispatch(ZOD_REJECTION);
    expect(sent).toHaveLength(1);
    const payload = (sent[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.id).toBe("req1");
    // Load-bearing: `result` present, `error` absent, isError preserved.
    expect(payload.error).toBeUndefined();
    expect(payload.result).toEqual(ZOD_REJECTION);
  });

  it("does not throw on a non-object result (guard is a narrow type check)", async () => {
    for (const odd of [null, undefined, "plain string", 42]) {
      const { logLines, sent } = await dispatch(odd);
      expect(outcomeLine(logLines)).toContain("ok");
      expect(sent).toHaveLength(1);
    }
  });
});
