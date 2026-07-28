import { describe, it, expect } from "vitest";

import { buildManifest } from "@connector/manifest/build.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { ConnectorConfig } from "@connector/config.js";

// v1.3 — pins the "one bad MCP does not sink the manifest" property.
// Before item #4 of architectural-plans/CODE-HYGINE.md shipped, prompts and
// resources already degraded per-server (safeList wrapped) but tools/list
// was a bare await inside Promise.all — a single MCP rejecting listTools()
// would collapse the entire manifest at boot and block register.
//
// Trust boundary is per-MCP-server, not per-capability. That invariant is
// tested here for the tools/list method specifically; the prompts/resources
// side is covered by build-prompts-resources.test.ts.

// Minimal McpServerConnection stub. We only need the fields buildManifest
// touches: name, transport, capabilities, listTools, listPrompts,
// listResources, listResourceTemplates. Everything else is defaulted to
// no-op rejections since buildManifest never calls them for its degradation
// path.
function stubConnection(
  name: string,
  overrides: Partial<Pick<McpServerConnection,
    "listTools" | "listPrompts" | "listResources" | "listResourceTemplates" | "capabilities"
  >>,
): McpServerConnection {
  const unused = (): never => { throw new Error(`unused in buildManifest test: ${name}`); };
  return {
    name,
    transport: "http",
    capabilities: overrides.capabilities,
    listTools: overrides.listTools ?? (async () => []),
    listPrompts: overrides.listPrompts ?? (async () => []),
    listResources: overrides.listResources ?? (async () => []),
    listResourceTemplates: overrides.listResourceTemplates ?? (async () => []),
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

function baseConfig(): ConnectorConfig {
  return {
    tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
    mcp_servers: [
      { name: "good", transport: "http" },
      { name: "bad", transport: "http" },
    ],
    policy: {
      max_concurrent_calls: 1,
      log_tool_args: false,
      tool_timeout_ms: 1000,
      heartbeat_interval_ms: 1000,
      reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
    },
  } as unknown as ConnectorConfig;
}

describe("buildManifest — per-server degradation (item #4)", () => {
  it("one MCP's tools/list rejection does NOT sink the whole manifest", async () => {
    const good = stubConnection("good", {
      listTools: async () => [
        { name: "ok", description: "test", inputSchema: { type: "object" } as never },
      ],
    });
    const bad = stubConnection("bad", {
      listTools: async () => { throw new Error("upstream 500 on tools/list"); },
    });

    const manifest = await buildManifest(
      baseConfig(),
      new Map([["good", good], ["bad", bad]]),
      "test",
    );

    // Both descriptors ship — the failure was quarantined to the offending MCP.
    expect(manifest.servers).toHaveLength(2);
    const goodDesc = manifest.servers.find((s) => s.name === "good");
    const badDesc = manifest.servers.find((s) => s.name === "bad");

    // Good MCP surfaces its tool untouched.
    expect(goodDesc?.tools).toHaveLength(1);
    expect(goodDesc?.tools[0]?.name).toBe("ok");

    // Bad MCP degrades to tools:[] rather than throwing out of buildManifest.
    // This matches an empty-tools resting state (e.g. a creds-gated MCP
    // pre-creds) — the controller's manifest-delta path handles it
    // identically.
    expect(badDesc?.tools).toEqual([]);
  });

  it("all MCPs rejecting tools/list yields an empty-tools manifest, not a crash", async () => {
    const a = stubConnection("a", { listTools: async () => { throw new Error("boom-a"); } });
    const b = stubConnection("b", { listTools: async () => { throw new Error("boom-b"); } });

    const manifest = await buildManifest(
      { ...baseConfig(), mcp_servers: [{ name: "a", transport: "http" }, { name: "b", transport: "http" }] } as ConnectorConfig,
      new Map([["a", a], ["b", b]]),
      "test",
    );

    expect(manifest.servers).toHaveLength(2);
    for (const s of manifest.servers) expect(s.tools).toEqual([]);
  });

  it("prompts/resources degrade independently of tools/list (existing safeList behavior)", async () => {
    // Guards the invariant that fixing tools/list didn't introduce a new
    // coupling — a server with capabilities: {prompts:{}, resources:{}}
    // whose tools/list rejects should still surface tools:[] and try
    // prompts/resources normally.
    const server = stubConnection("mixed", {
      capabilities: { prompts: {}, resources: {} },
      listTools: async () => { throw new Error("tools boom"); },
      listPrompts: async () => [{ name: "hello", description: "" }],
      listResources: async () => [{ uri: "test://motd", name: "motd" }],
    });

    const config = {
      ...baseConfig(),
      mcp_servers: [{ name: "mixed", transport: "http" }],
    } as ConnectorConfig;

    const manifest = await buildManifest(config, new Map([["mixed", server]]), "test");

    expect(manifest.servers).toHaveLength(1);
    const desc = manifest.servers[0]!;
    expect(desc.tools).toEqual([]);
    expect(desc.prompts).toHaveLength(1);
    expect(desc.resources).toHaveLength(1);
  });
});
