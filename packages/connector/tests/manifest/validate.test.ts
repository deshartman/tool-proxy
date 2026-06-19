import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture log calls without going through pino's fd-1 destination (which
// bypasses process.stdout.write and would make output assertions impossible).
// vi.hoisted lifts the spy declarations above the auto-hoisted vi.mock so the
// factory can close over them without "before initialization" errors.
const { warnSpy, infoSpy, errorSpy, debugSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
  debugSpy: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: infoSpy,
    error: errorSpy,
    debug: debugSpy,
    child: () => ({ warn: warnSpy, info: infoSpy, error: errorSpy, debug: debugSpy }),
  }),
}));

import { validateManifestSchemas } from "../../src/manifest/validate.js";
import type { ConnectorConfig, McpServerSpec } from "../../src/config.js";
import type { ToolManifest, ToolDescriptor } from "../../src/tunnel/frames.js";

beforeEach(() => {
  warnSpy.mockClear();
  infoSpy.mockClear();
  errorSpy.mockClear();
  debugSpy.mockClear();
});

// validateManifestSchemas is the manifest-time guardrail behind the
// hydration story. The behaviours pinned here:
//   * Type 1 / Type 3 missing schema → log.error per tool, no throw
//     (we authored these, but a missing schema is a bug we report and
//     keep booting from — the rest of the manifest still works)
//   * Type 2 (external) missing schema → silent pass-through
//     (we don't author these; the controller handles it gracefully)
//   * Healthy manifest → no log at all

function specType1(name: string): McpServerSpec {
  return {
    name,
    transport: "http",
    dir: `/abs/${name}`,
    timeout_ms: 5000,
    // no endpoint — Type 1 = http + dir + !endpoint per isType1Spawn
  };
}

function specType3(name: string): McpServerSpec {
  return {
    name,
    transport: "stdio",
    command: [`/opt/bundled-mcps/${name}/.venv/bin/${name}`],
    bundled: name,
    timeout_ms: 30_000,
  };
}

function specType2Http(name: string): McpServerSpec {
  return {
    name,
    transport: "http",
    endpoint: `http://localhost:8080/${name}`,
    timeout_ms: 5000,
  };
}

function tool(name: string, withSchema: boolean): ToolDescriptor {
  return {
    name,
    description: `${name} — fixture`,
    inputSchema: { type: "object" },
    ...(withSchema ? { outputSchema: { type: "object" } } : {}),
    allowed: true,
  };
}

function makeConfig(specs: McpServerSpec[]): ConnectorConfig {
  // Only mcp_servers is read by the validator — everything else can be a
  // minimal placeholder. Cast through unknown to skip the rest of the shape.
  return { mcp_servers: specs } as unknown as ConnectorConfig;
}

function makeManifest(
  servers: { name: string; tools: ToolDescriptor[] }[],
): ToolManifest {
  return {
    connectorId: "",
    environment: "test",
    version: "test",
    servers: servers.map((entry) => ({
      name: entry.name,
      transport: "http",
      author: "customer",
      tools: entry.tools,
    })),
  };
}

// Concatenate every error-call's serialized arguments so a `toContain` on
// the result hits whether the missing tool id ended up in the structured
// arg or the message string.
function errorOutput(): string {
  return errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
}

describe("validateManifestSchemas", () => {
  it("logs nothing when every Type 1 / Type 3 tool has an outputSchema", () => {
    const config = makeConfig([specType1("crm"), specType3("enterprise-knowledge")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("get_customer", true)] },
      { name: "enterprise-knowledge", tools: [tool("knowledge_query", true)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs ERROR per offending Type 1 tool but does NOT throw", () => {
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("issue_refund", false)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const out = errorOutput();
    expect(out).toContain("crm.issue_refund");
    expect(out).not.toContain("crm.get_recent");
  });

  it("logs ERROR for every missing Type 1 / Type 3 tool — no aggregation, one call each", () => {
    const config = makeConfig([
      specType1("crm"),
      specType1("sample"),
      specType3("enterprise-knowledge"),
    ]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_customer", false), tool("issue_refund", false)] },
      { name: "sample", tools: [tool("uuid", false)] },
      { name: "enterprise-knowledge", tools: [tool("knowledge_query", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    expect(errorSpy).toHaveBeenCalledTimes(4);
    const out = errorOutput();
    expect(out).toContain("crm.get_customer");
    expect(out).toContain("crm.issue_refund");
    expect(out).toContain("sample.uuid");
    expect(out).toContain("enterprise-knowledge.knowledge_query");
  });

  it("logs nothing for an empty manifest", () => {
    const config = makeConfig([]);
    const manifest = makeManifest([]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("Type 2 external tools missing schema pass through silently — controller handles them", () => {
    // The trust boundary point: we don't author Type 2 upstream tools, so
    // we don't get to enforce their shape. The controller has been coded
    // to handle missing schemas gracefully on its end.
    const config = makeConfig([specType2Http("aviation-weather")]);
    const manifest = makeManifest([
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("mixed: Type 1 missing logs ERROR; Type 2 missing is silent", () => {
    const config = makeConfig([
      specType1("crm"),
      specType2Http("aviation-weather"),
    ]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("issue_refund", false)] },
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    // Exactly one error line — the Type 1 gap. Type 2 stays silent;
    // if aviation-weather leaks into the error log the trust boundary
    // has collapsed.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const out = errorOutput();
    expect(out).toContain("crm.issue_refund");
    expect(out).not.toContain("aviation-weather.wx_metar");
  });
});
