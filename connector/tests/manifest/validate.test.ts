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

// validateManifestSchemas is the manifest-time advisory behind the
// hydration story. The behaviours pinned here:
//   * MCP we ship missing schema → ONE log.warn per server, listing every
//     affected tool (terse, friendly, actionable). Connector keeps booting.
//   * External MCP missing schema → silent pass-through (controller handles
//     missing schemas on its end).
//   * Healthy manifest → no log at all.

function specType1(name: string): McpServerSpec {
  return {
    name,
    transport: "http",
    dir: `/abs/${name}`,
    timeout_ms: 5000,
    // no endpoint — Type 1 = http + dir + !endpoint per isType1Spawn
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

// Concatenate every warn-call's serialized arguments so a `toContain` on
// the result hits whether a missing tool id ended up in the structured
// arg or the message string.
function warnOutput(): string {
  return warnSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
}

describe("validateManifestSchemas", () => {
  it("logs nothing when every shipped tool has an outputSchema", () => {
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("get_customer", true)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs one WARN per server, naming each missing tool, but does NOT throw", () => {
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("issue_refund", false)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const out = warnOutput();
    expect(out).toContain("crm");
    expect(out).toContain("issue_refund");
    // Healthy tool must NOT appear in the warning.
    expect(out).not.toContain("get_recent");
    // No error logs — this is advisory, not an error.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("aggregates one WARN per server even when multiple tools on that server are missing", () => {
    const config = makeConfig([specType1("crm"), specType1("sample")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_customer", false), tool("issue_refund", false)] },
      { name: "sample", tools: [tool("uuid", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    // Two servers with missing tools → exactly two WARN lines (not three —
    // crm aggregates its two missing tools into a single line). One line
    // per server is the whole point of the new shape.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const out = warnOutput();
    expect(out).toContain("get_customer");
    expect(out).toContain("issue_refund");
    expect(out).toContain("sample");
    expect(out).toContain("uuid");
  });

  it("logs nothing for an empty manifest", () => {
    const config = makeConfig([]);
    const manifest = makeManifest([]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("external (Type 2) tools missing schema pass through silently — controller handles them", () => {
    const config = makeConfig([specType2Http("aviation-weather")]);
    const manifest = makeManifest([
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("mixed: shipped MCP missing schema warns; external MCP missing schema is silent", () => {
    const config = makeConfig([
      specType1("crm"),
      specType2Http("aviation-weather"),
    ]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("issue_refund", false)] },
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    // Exactly one warning — the shipped MCP's gap. The external MCP stays
    // silent; if aviation-weather leaks into the warn log the boundary
    // has collapsed.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const out = warnOutput();
    expect(out).toContain("crm");
    expect(out).toContain("issue_refund");
    expect(out).not.toContain("aviation-weather");
    expect(out).not.toContain("wx_metar");
  });

  it("uses singular wording for a single missing tool", () => {
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("issue_refund", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    const out = warnOutput();
    // "1 tool ... does not declare ... this tool by name only" rather
    // than "1 tools ... do not ... these tools by name only".
    expect(out).toContain("1 tool ");
    expect(out).toContain(" does not declare");
    expect(out).toContain("this tool by name only");
    expect(out).not.toContain("1 tools ");
    expect(out).not.toContain("these tools");
  });

  it("uses plural wording for multiple missing tools on one server", () => {
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_customer", false), tool("issue_refund", false)] },
    ]);
    validateManifestSchemas(manifest, config);
    const out = warnOutput();
    expect(out).toContain("2 tools");
    expect(out).toContain(" do not declare");
    expect(out).toContain("these tools by name only");
  });
});
