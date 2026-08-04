import { describe, it, expect, afterEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHttpServer, type McpHttpServerHandle } from "@connector/sdk/http-server.js";

// Pins the factory's `capabilities` option — the seam that lets protocol
// extensions (MEMORY-MCP-INTERFACE.md §7's identity+memory shape) advertise
// custom capability groups on the MCP initialize handshake.
//
// Two guarantees under test:
//   1) Custom keys survive the round-trip: what the caller passes ends up on
//      the SDK Client's getServerCapabilities() output verbatim.
//   2) Standard-key precedence: opts.capabilities merges first, so if a
//      caller accidentally sets `tools: false` (or similar) it CANNOT
//      overwrite the factory-managed presence keys.

describe("createMcpHttpServer with custom capabilities", () => {
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

  it("advertises custom capability keys via the MCP `extensions` envelope alongside standard presence keys", async () => {
    // MCP `2026-07-28` promotes `extensions` (a Record<string, object>) to a
    // first-class ServerCapabilities field — the sanctioned home for
    // non-standard capability groups. Our factory passes `capabilities`
    // through verbatim, so callers advertise custom shapes under `extensions`
    // with a vendor namespace ("agentic-memory" here). This also pins that
    // v2's ServerCapabilitiesSchema PRESERVES `extensions` (does not strip it)
    // end-to-end through getServerCapabilities().
    handle = await createMcpHttpServer({
      name: "custom-caps-test",
      tools: [],
      port: 0,
      capabilities: {
        extensions: {
          "agentic-memory": {
            protocolVersion: "2026-07",
            identity: { supported: true, maxAliases: 100 },
            memory: {
              episodic: { supported: true, maxResults: 50 },
              semantic: { supported: true, maxResolvedSizeBytes: 1_048_576 },
            },
            unknownFieldBehavior: "ignore",
          },
        },
      },
    });

    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);

    const caps = client.getServerCapabilities() as Record<string, unknown> | undefined;
    expect(caps).toBeDefined();
    expect(caps!.tools).toBeDefined();
    const extensions = caps!.extensions as Record<string, unknown> | undefined;
    expect(extensions).toBeDefined();
    const am = extensions!["agentic-memory"] as Record<string, unknown>;
    expect(am.protocolVersion).toBe("2026-07");
    expect(am.identity).toEqual({ supported: true, maxAliases: 100 });
    expect(am.memory).toEqual({
      episodic: { supported: true, maxResults: 50 },
      semantic: { supported: true, maxResolvedSizeBytes: 1_048_576 },
    });
    expect(am.unknownFieldBehavior).toBe("ignore");
  });

  it("standard presence keys win over caller-supplied capabilities of the same name", async () => {
    // The merge order in http-server.ts:
    //   { ...(opts.capabilities ?? {}), tools: {} }
    // ensures a caller passing `tools: "banana"` (or any nonsense) cannot
    // shadow the SDK's tools-list contract. Same for prompts/resources when
    // items are registered.
    handle = await createMcpHttpServer({
      name: "collision-test",
      tools: [],
      port: 0,
      capabilities: {
        tools: "banana",
        prompts: "peach",
        resources: "kiwi",
      } as Record<string, unknown>,
    });

    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);

    const caps = client.getServerCapabilities() as Record<string, unknown> | undefined;
    // v2's McpServer augments the tools presence key with `listChanged: true`
    // (it supports tools/list_changed via subscriptions/listen). The point of
    // this test is unchanged: the caller's `tools: "banana"` is overwritten by
    // the factory-managed capability and cannot shadow the SDK's tools
    // contract.
    expect(caps!.tools).toEqual({ listChanged: true });
    // prompts / resources are only added when items are registered — with
    // zero prompts and zero resources, the caller's collision values are
    // stripped (the assignment is unconditional after the length checks
    // would fire).
    expect(caps!.prompts).toBeUndefined();
    expect(caps!.resources).toBeUndefined();
  });
});
