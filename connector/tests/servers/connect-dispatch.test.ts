import { describe, it, expect, vi, beforeEach } from "vitest";

// Pin the W-E5 transport-dispatch branch in src/servers/connect.ts.
//
// Manual scenarios surfaced by the controller-driven roster: an operator
// can pick Transport=sse / streamable-http / stdio in the "New 3rd Party
// MCP" UI. The connector translates each to McpServerSpec shape — which has
// only `http` / `stdio` transports — and routes the HTTP-family variants
// through `__transportKind`. If dispatch picks the wrong transport class,
// the upstream connection silently uses the wrong protocol (e.g. SSE entry
// tries to streamable-POST and the server 405s). A stale `websocket` entry
// (transport removed in SDK v2) must be rejected clearly, not misrouted.
//
// We mock the SDK transport constructors and the Client.connect so this
// test exercises ONLY the dispatch decision — not real network I/O.

import type { McpServerSpec } from "../../src/config.js";

// Capture which transport class was instantiated.
const constructed: Array<{ kind: string; url: string; opts?: unknown }> = [];

// One mock per module — Client + both HTTP-family transports come from the
// same v2 package root, so they must be returned from a SINGLE vi.mock (a
// second vi.mock of the same module replaces the first, it does not merge).
vi.mock("@modelcontextprotocol/client", () => ({
  Client: class MockClient {
    async connect() { /* noop */ }
    async close() { /* noop */ }
    async listTools() { return { tools: [] }; }
    async callTool() { return {}; }
  },
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: unknown) {
      constructed.push({ kind: "streamable-http", url: url.toString(), opts });
    }
  },
  SSEClientTransport: class {
    constructor(url: URL, opts?: unknown) {
      constructed.push({ kind: "sse", url: url.toString(), opts });
    }
  },
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    constructor(opts: unknown) {
      constructed.push({ kind: "stdio", url: "(stdio)", opts });
    }
  },
}));

// Import AFTER the mocks so the SDK references are wired through.
const { connectServer } = await import("../../src/servers/connect.js");

describe("connectServer dispatch", () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it("http spec without __transportKind → StreamableHTTPClientTransport (yaml + roster default)", async () => {
    const spec: McpServerSpec = {
      name: "x",
      transport: "http",
      endpoint: "https://example.com/mcp",
      timeout_ms: 5000,
    };
    await connectServer(spec);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ kind: "streamable-http", url: "https://example.com/mcp" });
  });

  it("http spec with __transportKind: 'sse' → SSEClientTransport", async () => {
    const spec: McpServerSpec & { __transportKind?: string } = {
      name: "x",
      transport: "http",
      endpoint: "https://example.com/mcp/sse",
      __transportKind: "sse",
      timeout_ms: 5000,
    };
    await connectServer(spec);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ kind: "sse", url: "https://example.com/mcp/sse" });
  });

  it("http spec with __transportKind: 'websocket' → rejected (transport removed in SDK v2)", async () => {
    // WebSocket is no longer an MCP transport. A stale entry from an older
    // controller must be rejected clearly — never misrouted to connectHttp,
    // which would try to speak HTTP at a wss:// endpoint.
    const spec: McpServerSpec & { __transportKind?: string } = {
      name: "x",
      transport: "http",
      endpoint: "wss://example.com/mcp",
      __transportKind: "websocket",
      timeout_ms: 5000,
    };
    await expect(connectServer(spec)).rejects.toThrow(/websocket.*no longer supported/i);
    expect(constructed).toHaveLength(0);
  });

  it("stdio spec → StdioClientTransport (kind never consulted)", async () => {
    const spec: McpServerSpec = {
      name: "x",
      transport: "stdio",
      command: ["echo", "hello"],
      timeout_ms: 5000,
    };
    await connectServer(spec);
    expect(constructed).toHaveLength(1);
    expect(constructed[0].kind).toBe("stdio");
  });

  it("stdio spec WITH env arg → transport sees the supervisor-merged env (controllerEnv path)", async () => {
    // Bug fix 2026-06-28: stdio MCPs added via the controller UI (3rd-party
    // roster) booted with empty process.env because connectStdio built its
    // env internally from process.env + spec.env, ignoring the supervisor's
    // controllerEnv layer. The fix threads the supervisor's merged env
    // through connectServer → connectStdio → StdioClientTransport.
    //
    // This test pins that contract: when startEntry passes `env`, the
    // transport MUST receive exactly that env (not process.env, not spec.env
    // alone). A regression here means controller-supplied creds are silently
    // dropped on the floor for every stdio MCP.
    const spec: McpServerSpec = {
      name: "twilio-api",
      transport: "stdio",
      command: ["twilio-mcp"],
      env: { TWILIO_ACCOUNT_SID: "AC_from_spec" }, // dir/.env layer
      timeout_ms: 5000,
    };
    const merged = {
      // What the supervisor would build: process.env baseline + spec.env +
      // controllerEnv winning per-key. controllerEnv wins TWILIO_ACCOUNT_SID.
      PATH: "/usr/bin",
      TWILIO_ACCOUNT_SID: "AC_from_controller",
      TWILIO_AUTH_TOKEN: "AT_from_controller",
    };
    await connectServer(spec, merged);
    expect(constructed).toHaveLength(1);
    expect(constructed[0].kind).toBe("stdio");
    // Pin the exact env handed to the SDK transport — no surprises.
    expect((constructed[0].opts as { env?: Record<string, string> }).env).toEqual(merged);
  });

  it("stdio spec WITHOUT env arg → legacy fallback (process.env + spec.env) — no controllerEnv flows", async () => {
    // The legacy shape, kept for callers that don't have a supervisor-built
    // env (discover.ts, tests). Confirms the spec.env layer applies but
    // nothing fancier — supervisor callsites MUST pass env explicitly.
    const spec: McpServerSpec = {
      name: "x",
      transport: "stdio",
      command: ["something"],
      env: { CUSTOM_KEY: "from_spec" },
      timeout_ms: 5000,
    };
    await connectServer(spec); // No env arg
    expect(constructed).toHaveLength(1);
    const passedEnv = (constructed[0].opts as { env?: Record<string, string> }).env;
    expect(passedEnv).toBeDefined();
    // spec.env layered on top of process.env — CUSTOM_KEY must be present.
    expect(passedEnv?.CUSTOM_KEY).toBe("from_spec");
    // process.env's PATH leaks in (this is the legacy behaviour — supervisor
    // callers always pass env so this branch only fires for non-supervisor
    // callsites that want exactly this fallback).
    expect(passedEnv?.PATH).toBeDefined();
  });

  it("http spec with __transportKind: 'streamable-http' (explicit) → StreamableHTTPClientTransport", async () => {
    // The coordinator only stamps __transportKind for sse / websocket and
    // leaves streamable-http / http as undefined. But pin the behavior
    // when the kind is explicitly set, so a future change (e.g. always
    // stamp it for completeness) keeps the dispatch correct.
    const spec: McpServerSpec & { __transportKind?: string } = {
      name: "x",
      transport: "http",
      endpoint: "https://example.com/mcp",
      __transportKind: "streamable-http",
      timeout_ms: 5000,
    };
    await connectServer(spec);
    expect(constructed).toHaveLength(1);
    expect(constructed[0].kind).toBe("streamable-http");
  });

  it("passes spec.headers through requestInit.headers for http and sse", async () => {
    // W-E3 wire-through is the load-bearing piece for the Authorization
    // header. Pin that connectHttp and connectSse both forward it.
    const httpSpec: McpServerSpec = {
      name: "x",
      transport: "http",
      endpoint: "https://example.com/mcp",
      headers: { Authorization: "Bearer t1" },
      timeout_ms: 5000,
    };
    await connectServer(httpSpec);
    expect((constructed[0].opts as { requestInit?: { headers?: Record<string, string> } }).requestInit?.headers).toEqual({
      Authorization: "Bearer t1",
    });

    constructed.length = 0;
    const sseSpec: McpServerSpec & { __transportKind?: string } = {
      name: "x",
      transport: "http",
      endpoint: "https://example.com/mcp/sse",
      headers: { "X-API-Key": "k1" },
      __transportKind: "sse",
      timeout_ms: 5000,
    };
    await connectServer(sseSpec);
    expect((constructed[0].opts as { requestInit?: { headers?: Record<string, string> } }).requestInit?.headers).toEqual({
      "X-API-Key": "k1",
    });
  });
});
