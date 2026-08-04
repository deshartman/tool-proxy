import { describe, it, expect } from "vitest";

import { buildManifest } from "@connector/manifest/build.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";

// §9.2 — the negotiated MCP protocol revision (captured on the connection at
// connect time) surfaces per-ServerDescriptor as `protocolVersion`, so the
// controller can render an era badge. Additive + advisory: absent when the SDK
// client didn't expose the negotiated version (e.g. a test mock or a peer that
// never negotiated).

function stubConnection(name: string, protocolVersion?: string): McpServerConnection {
  const unused = (): never => { throw new Error(`unused: ${name}`); };
  return {
    name,
    transport: "http",
    protocolVersion,
    listTools: async () => [{ name: "t", description: "d", inputSchema: { type: "object" } as never }],
    listPrompts: async () => [],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    callTool: unused,
    getPrompt: unused,
    readResource: unused,
    subscribeResource: unused,
    unsubscribeResource: unused,
    complete: unused,
    setLoggingLevel: unused,
    onNotification: () => () => undefined,
    close: async () => undefined,
  };
}

function config(names: string[]): ConnectorConfig {
  return {
    tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
    mcp_servers: names.map((name) => ({ name, transport: "http" })),
    policy: {
      max_concurrent_calls: 1, log_tool_args: false, tool_timeout_ms: 1000,
      heartbeat_interval_ms: 1000,
      reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
    },
  } as unknown as ConnectorConfig;
}

describe("buildManifest — §9.2 negotiated protocol era", () => {
  it("surfaces the negotiated protocolVersion on the ServerDescriptor", async () => {
    const servers = new Map<string, McpServerConnection>([
      ["modern", stubConnection("modern", "2026-07-28")],
      ["legacy", stubConnection("legacy", "2025-11-25")],
    ]);
    const manifest = await buildManifest(config(["modern", "legacy"]), servers, "1.0.0");

    expect(manifest.servers.find((s) => s.name === "modern")?.protocolVersion).toBe("2026-07-28");
    expect(manifest.servers.find((s) => s.name === "legacy")?.protocolVersion).toBe("2025-11-25");
  });

  it("omits protocolVersion when the connection didn't expose one", async () => {
    const servers = new Map<string, McpServerConnection>([["x", stubConnection("x", undefined)]]);
    const manifest = await buildManifest(config(["x"]), servers, "1.0.0");

    const descriptor = manifest.servers.find((s) => s.name === "x");
    expect(descriptor).toBeDefined();
    expect(descriptor).not.toHaveProperty("protocolVersion");
  });
});
