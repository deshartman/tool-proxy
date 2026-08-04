import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createMcpHttpServer, type McpHttpServerHandle } from "@connector/sdk/http-server.js";
import type { Tool } from "@connector/sdk/index.js";

// Verifies the MCP `2026-07-28` end-to-end path the rest of the suite doesn't
// reach. Every other integration test connects a default Client (no
// versionNegotiation) — that stays on the 2025 handshake. This one proves the
// v2-migration goal: an AUTO-negotiating client against our
// createMcpHandler-backed Type 1 server actually lands on the MODERN era,
// tools work over it, the SAME server still serves a legacy (2025) client
// (dual-era via `legacy: 'stateless'`), and a `subscriptions/listen` stream
// opens. Regression guard for the SDK-v2 migration.

const pingTool: Tool = {
  name: "ping",
  register(server) {
    server.registerTool(
      "ping",
      {
        description: "test ping",
        inputSchema: z.object({ who: z.string().optional() }),
        outputSchema: z.object({ value: z.string() }),
      },
      async ({ who }) => ({
        structuredContent: { value: `pong ${who ?? "world"}` },
        content: [{ type: "text", text: `pong ${who ?? "world"}` }],
      }),
    );
  },
};

describe("createMcpHttpServer — 2026-07-28 end-to-end", () => {
  let handle: McpHttpServerHandle;
  const clients: Client[] = [];

  beforeAll(async () => {
    handle = await createMcpHttpServer({ name: "v2-negotiation-test", tools: [pingTool], port: 0 });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
  });

  afterAll(async () => {
    await handle.close();
  });

  async function connectClient(opts: ConstructorParameters<typeof Client>[1]): Promise<Client> {
    const client = new Client({ name: "test-client", version: "0.0.0" }, opts);
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);
    return client;
  }

  it("auto-negotiation reaches the modern (2026-07-28) era against our createMcpHandler server", async () => {
    const client = await connectClient({ capabilities: {}, versionNegotiation: { mode: "auto" } });
    expect(client.getProtocolEra()).toBe("modern");
  });

  it("tools work over the modern connection", async () => {
    const client = await connectClient({ capabilities: {}, versionNegotiation: { mode: "auto" } });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
    const res = (await client.callTool({ name: "ping", arguments: { who: "v2" } })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(res.content.find((b) => b.type === "text")?.text).toBe("pong v2");
  });

  it("the same server also serves a legacy (2025-era) client — dual-era", async () => {
    // No versionNegotiation → the default 2025 `initialize` handshake. The
    // createMcpHandler default (`legacy: 'stateless'`) must still serve it.
    const client = await connectClient({ capabilities: {} });
    expect(client.getProtocolEra()).not.toBe("modern");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
  });

  it("subscriptions/listen opens on the modern connection", async () => {
    const client = await connectClient({ capabilities: {}, versionNegotiation: { mode: "auto" } });
    const sub = await client.listen({ toolsListChanged: true });
    expect(sub).toBeDefined();
    expect(sub.honoredFilter).toBeDefined();
    await sub.close();
  });
});
