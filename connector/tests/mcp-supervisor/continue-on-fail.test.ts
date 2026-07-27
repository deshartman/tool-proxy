import { describe, it, expect, vi, beforeEach } from "vitest";

// Vitest hoists vi.mock. The mock target must resolve identically to the
// path the production code imports, so we mock the `.js` specifier used in
// mcp-supervisor.ts's import.
const connectServerMock = vi.fn();
vi.mock("../../src/servers/connect.js", () => ({
  connectServer: (...args: unknown[]) => connectServerMock(...args),
}));

import { McpSupervisor } from "../../src/mcp-supervisor.js";
import type { McpServerSpec } from "../../src/config.js";
import type { McpServerConnection } from "../../src/servers/index.js";

// Pins: startAll must LOG AND CONTINUE when one entry fails, not throw.
// Regression scenario: fly deploy with EK in the yaml but no reachable
// Postgres — EK's stdio child dies at import, connectServer throws
// ECONNREFUSED, and prior behavior was that agentic-memory (registered
// after EK) never got its turn. See fix/supervisor-continue-on-fail.

function buildLog(): {
  log: Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  errorSpy: ReturnType<typeof vi.fn>;
} {
  const errorSpy = vi.fn();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "info",
    child: () => log,
  } as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  return { log, errorSpy };
}

function stdioSpec(name: string, command: string): McpServerSpec {
  return {
    name,
    transport: "stdio",
    command,
    args: [],
  } as unknown as McpServerSpec;
}

function fakeConnection(name: string): McpServerConnection {
  // Minimal shape — startEntry only sets it on the servers map and
  // reads .close() on shutdown paths we don't exercise here.
  return {
    name,
    close: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [] })),
  } as unknown as McpServerConnection;
}

describe("McpSupervisor.startAll — continue on per-entry failure", () => {
  beforeEach(() => {
    connectServerMock.mockReset();
  });

  it("second entry still connects when the first throws", async () => {
    const { log, errorSpy } = buildLog();
    const servers = new Map<string, McpServerConnection>();
    const supervisor = new McpSupervisor({ log, servers });

    const goodConn = fakeConnection("good-mcp");
    connectServerMock.mockImplementation(async (spec: McpServerSpec) => {
      if (spec.name === "bad-mcp") {
        throw new Error("simulated boot failure — postgres unreachable");
      }
      return goodConn;
    });

    await supervisor.register([
      stdioSpec("bad-mcp", "/nonexistent/bad"),
      stdioSpec("good-mcp", "/nonexistent/good"),
    ]);

    // startAll must resolve, not throw.
    await expect(supervisor.startAll()).resolves.toBeInstanceOf(Map);

    // Surviving entry landed in the shared map.
    expect(servers.has("good-mcp")).toBe(true);
    expect(servers.get("good-mcp")).toBe(goodConn);
    expect(servers.has("bad-mcp")).toBe(false);

    // Failure was logged, not swallowed silently. The regression this
    // pins was one where the error surfaced as an uncaught rejection
    // instead of a per-entry log line.
    const errorCalls = errorSpy.mock.calls;
    const bootFail = errorCalls.find(
      (call) =>
        typeof call[1] === "string" &&
        call[1].includes("MCP boot failed"),
    );
    expect(bootFail, "expected a 'MCP boot failed' error log").toBeDefined();
    const meta = bootFail?.[0] as { name?: string } | undefined;
    expect(meta?.name).toBe("bad-mcp");
  });

  it("all entries fail — startAll still resolves cleanly", async () => {
    const { log } = buildLog();
    const servers = new Map<string, McpServerConnection>();
    const supervisor = new McpSupervisor({ log, servers });

    connectServerMock.mockRejectedValue(new Error("everything broken"));

    await supervisor.register([
      stdioSpec("a", "/nonexistent/a"),
      stdioSpec("b", "/nonexistent/b"),
    ]);

    await expect(supervisor.startAll()).resolves.toBeInstanceOf(Map);
    expect(servers.size).toBe(0);
    // connectServer got called for BOTH entries — no early bail-out.
    expect(connectServerMock).toHaveBeenCalledTimes(2);
  });
});
