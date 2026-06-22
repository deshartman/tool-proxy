import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildManifest } from "@connector/manifest/build.js";
import { createMcpHttpServer, type McpHttpServerHandle } from "@connector/sdk/http-server.js";
import { makeConnection, type McpServerConnection } from "@connector/servers/index.js";
import type { Tool, Prompt, Resource } from "@connector/sdk/index.js";
import type { ConnectorConfig } from "@connector/config.js";

// v1.2 — MCP-CLIENT-USE Workstream B regression. The manifest carries
// prompts[] and resources[] alongside tools[] when the upstream SDK server
// declared the matching capability. Older controllers (tools-only) ignore
// the new fields by spec — see docs/MCP-PROTOCOL.md "Frame envelope".

const sampleTool: Tool = {
  name: "ping",
  register(server) {
    server.registerTool("ping", { description: "test" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  },
};

const samplePrompt: Prompt = {
  name: "hello",
  register(server) {
    server.registerPrompt(
      "hello",
      { description: "Greeting prompt" },
      () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }),
    );
  },
};

const sampleResource: Resource = {
  name: "motd",
  register(server) {
    server.registerResource(
      "motd",
      "test://motd",
      { mimeType: "text/plain" },
      async (uri) => ({ contents: [{ uri: uri.toString(), text: "hi" }] }),
    );
  },
};

describe("buildManifest with prompts + resources", () => {
  let handle: McpHttpServerHandle | undefined;
  let client: Client | undefined;
  let connection: McpServerConnection | undefined;

  afterEach(async () => {
    if (client) { await client.close(); client = undefined; }
    if (handle) { await handle.close(); handle = undefined; }
    connection = undefined;
  });

  function configFor(): ConnectorConfig {
    return {
      tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
      mcp_servers: [{ name: "demo", transport: "http" }],
      policy: { max_concurrent_calls: 1, log_tool_args: false, tool_timeout_ms: 1000, heartbeat_interval_ms: 1000, reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 } },
    } as unknown as ConnectorConfig;
  }

  it("surfaces tools, prompts, and resources from the upstream server", async () => {
    handle = await createMcpHttpServer({
      name: "demo",
      tools: [sampleTool],
      prompts: [samplePrompt],
      resources: [sampleResource],
      port: 0,
    });
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);
    connection = makeConnection("demo", "http", client);

    const servers = new Map<string, McpServerConnection>([["demo", connection]]);
    const manifest = await buildManifest(configFor(), servers, "test", "/tmp/connector.yaml");

    expect(manifest.servers).toHaveLength(1);
    const [server] = manifest.servers;
    expect(server.name).toBe("demo");
    expect(server.tools.map((t) => t.name)).toEqual(["ping"]);
    expect(server.prompts?.map((p) => p.name)).toEqual(["hello"]);
    expect(server.resources?.map((r) => r.uri)).toEqual(["test://motd"]);
    // Capabilities should reflect what the SDK server advertised.
    expect(server.capabilities?.prompts).toBeDefined();
    expect(server.capabilities?.resources).toBeDefined();
  });

  it("a tools-only server surfaces no prompts/resources fields (older shape)", async () => {
    handle = await createMcpHttpServer({
      name: "demo",
      tools: [sampleTool],
      port: 0,
    });
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);
    connection = makeConnection("demo", "http", client);

    const servers = new Map<string, McpServerConnection>([["demo", connection]]);
    const manifest = await buildManifest(configFor(), servers, "test", "/tmp/connector.yaml");

    expect(manifest.servers).toHaveLength(1);
    expect(manifest.servers[0].prompts).toBeUndefined();
    expect(manifest.servers[0].resources).toBeUndefined();
    expect(manifest.servers[0].resourceTemplates).toBeUndefined();
  });
});
