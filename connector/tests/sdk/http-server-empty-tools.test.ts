import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createMcpHttpServer, type McpHttpServerHandle } from "@connector/sdk/http-server.js";
import type { Tool } from "@connector/sdk/tool.js";

// Defensive test for createMcpHttpServer's empty-tools path.
//
// Bug repro (boot 2026-06-21): mcp/bundled/twilio/server.ts under MCP-LOADING
// gates tool registration on creds. When .env is absent, it calls
// createMcpHttpServer({ tools: [] }) — and the connector's first
// client.listTools() at boot crashes with `MCP error -32601: Method not
// found`, killing buildManifest, killing the connector.
//
// Root cause: McpServer (from @modelcontextprotocol/sdk) wires its
// tools/list request handler lazily — only on the first registerTool()
// call. With zero tools registered, the server advertises `capabilities:
// { tools: {} }` but has no handler installed for the method.
//
// Fix: createMcpHttpServer installs an empty-list handler when tools is
// empty, so tools/list returns `{tools: []}` (the natural MCP semantics
// for "server up, no tools right now"). The supervisor's creds-update
// restart re-spawns with a non-empty tools array, and the SDK's own
// lazy-init handles things from there.
//
// This test exercises the wire end-to-end: boot a server with tools=[],
// connect a real MCP Client over the streamable HTTP transport, and
// assert tools/list returns successfully with an empty array — NOT
// -32601.

describe("createMcpHttpServer with zero tools", () => {
  let handle: McpHttpServerHandle | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("answers tools/list with an empty array (the creds-gated boot crash repro)", async () => {
    handle = await createMcpHttpServer({
      name: "apis-test",
      tools: [],
      port: 0,
      envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    });

    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools).toEqual([]);
  });

  it("still answers tools/list correctly when tools are registered (regression: empty-list handler MUST NOT shadow the SDK's own)", async () => {
    // The fix installs the empty-list handler ONLY when tools.length === 0.
    // This case exists to pin that gate — if a future refactor accidentally
    // installed it unconditionally, the SDK's own handler would be unable
    // to register (assertCanSetRequestHandler throws), or would be shadowed,
    // and tools/list would return [] even when tools exist.
    const fakeTool: Tool = {
      name: "ping",
      register(server) {
        server.registerTool("ping", { description: "test" }, async () => ({
          content: [{ type: "text", text: "pong" }],
        }));
      },
    };
    handle = await createMcpHttpServer({
      name: "apis-test-with-tools",
      tools: [fakeTool],
      port: 0,
    });

    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map((t) => t.name)).toEqual(["ping"]);
  });
});
