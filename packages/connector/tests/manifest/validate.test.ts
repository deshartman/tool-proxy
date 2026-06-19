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
//   * gated off by default → no throw, no warn (case 5 — keeps the rollout
//     ahead of the per-tool schema work without surprising a customer)
//   * Type 1 / Type 3 missing → throws (cases 2, 3 — we authored these, so
//     a missing schema is a bug we own)
//   * Type 2 missing → warns, no throw (case 6 — opaque upstream we don't
//     author; surface the gap, don't block boot)
//   * mixed → only Type 1 in the throw, only Type 2 in the warn (case 7 —
//     the asymmetry is the whole point of the trust boundary)

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

// Concatenate every warn-call's serialized arguments so a `toContain` on
// the result hits whether the missing tool id ended up in the structured
// arg or the message string.
function warnOutput(): string {
  return warnSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
}

describe("validateManifestSchemas — gated off (default)", () => {
  it("does nothing when STRICT_OUTPUT_SCHEMA is unset, even with missing schemas", () => {
    // Case 5. The rollout shipped this validator BEFORE the per-tool schema
    // work; until the gate flips at S6, customers running the connector
    // shouldn't see throws even if the manifest has gaps.
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", false)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("validateManifestSchemas — strict mode on", () => {
  it("returns clean when every Type 1 tool has an outputSchema (case 1)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
    const config = makeConfig([specType1("crm"), specType1("sample")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("get_customer", true)] },
      { name: "sample", tools: [tool("now", true)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws naming the exact <server>.<tool> when one Type 1 tool is missing (case 2)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
    const config = makeConfig([specType1("crm")]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("get_recent", true), tool("issue_refund", false)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).toThrow(/crm\.issue_refund/);
    // The healthy tool must NOT be in the error — false positives erode
    // operator trust the next time this fires.
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow(/crm\.get_recent/);
  });

  it("lists every missing Type 1 / Type 3 tool when multiple are missing (case 3)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
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
    let caught: Error | undefined;
    try {
      validateManifestSchemas(manifest, config);
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    expect(caught).toBeDefined();
    const message = caught?.message ?? "";
    expect(message).toContain("crm.get_customer");
    expect(message).toContain("crm.issue_refund");
    expect(message).toContain("sample.uuid");
    expect(message).toContain("enterprise-knowledge.knowledge_query");
    expect(message).toContain("(4)");
  });

  it("returns clean for an empty manifest (case 4)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
    const config = makeConfig([]);
    const manifest = makeManifest([]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
  });

  it("warns but does NOT throw when a Type 2 tool is missing (case 6)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
    const config = makeConfig([specType2Http("aviation-weather")]);
    const manifest = makeManifest([
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    expect(() => validateManifestSchemas(manifest, config)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnOutput()).toContain("aviation-weather.wx_metar");
  });

  it("mixed: throws naming only Type 1, warns naming only Type 2 (case 7)", () => {
    vi.stubEnv("STRICT_OUTPUT_SCHEMA", "1");
    const config = makeConfig([
      specType1("crm"),
      specType2Http("aviation-weather"),
    ]);
    const manifest = makeManifest([
      { name: "crm", tools: [tool("issue_refund", false)] },
      { name: "aviation-weather", tools: [tool("wx_metar", false)] },
    ]);
    let caught: Error | undefined;
    try {
      validateManifestSchemas(manifest, config);
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    expect(caught).toBeDefined();
    const message = caught?.message ?? "";
    // Throw mentions ONLY the authored gap. If aviation-weather leaks into
    // the throw message, the trust boundary has collapsed — that's the
    // regression this case exists to catch.
    expect(message).toContain("crm.issue_refund");
    expect(message).not.toContain("aviation-weather.wx_metar");

    // WARN was emitted (warnings happen BEFORE the throw, so they fire
    // even when the throw kills the function), and it names only the
    // Type 2 tool — symmetric to the throw's Type 1-only.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = warnOutput();
    expect(warnText).toContain("aviation-weather.wx_metar");
    expect(warnText).not.toContain("crm.issue_refund");
  });
});
