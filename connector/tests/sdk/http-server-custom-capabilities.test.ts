import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

  it("advertises custom capability keys via the MCP `experimental` envelope alongside standard presence keys", async () => {
    // MCP's ServerCapabilitiesSchema strips unknown top-level keys — but
    // `experimental` (a Record<string, object>) is the spec's designated
    // home for non-standard capability groups. Our factory passes
    // `capabilities` through verbatim, so callers who need to advertise
    // custom shapes wrap them under `experimental` with a vendor
    // namespace ("agentic-memory" here).
    handle = await createMcpHttpServer({
      name: "custom-caps-test",
      tools: [],
      port: 0,
      capabilities: {
        experimental: {
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
    const experimental = caps!.experimental as Record<string, unknown> | undefined;
    expect(experimental).toBeDefined();
    const am = experimental!["agentic-memory"] as Record<string, unknown>;
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
    expect(caps!.tools).toEqual({});
    // prompts / resources are only added when items are registered — with
    // zero prompts and zero resources, the caller's collision values are
    // stripped (the assignment is unconditional after the length checks
    // would fire).
    expect(caps!.prompts).toBeUndefined();
    expect(caps!.resources).toBeUndefined();
  });
});
