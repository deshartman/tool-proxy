import { describe, it, expect, vi } from "vitest";

import { McpSupervisor } from "../../src/mcp-supervisor.js";
import type { McpServerSpec } from "../../src/config.js";
import type { DropinSpec } from "../../src/dropin.js";
import type { McpServerConnection } from "../../src/servers/index.js";

// Pin W-E6: McpStatus.source distinguishes yaml-listed entries from
// controller-pushed 3rd-party MCPs, and mcpId is carried for
// controller-config entries. The inspector renders these as a badge +
// correlation id; without source on the wire, an operator can't tell
// the two classes apart from the inspector view.

function buildSupervisor(): McpSupervisor {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "info",
    child: () => log,
  } as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  return new McpSupervisor({
    log,
    servers: new Map<string, McpServerConnection>(),
  });
}

const yamlSpec: McpServerSpec = {
  name: "yaml-mcp",
  transport: "stdio",
  command: ["echo", "hello"],
  timeout_ms: 5000,
};

const rosterSpec: McpServerSpec = {
  name: "roster-mcp",
  transport: "stdio",
  command: ["echo", "world"],
  timeout_ms: 5000,
};

describe("McpSupervisor — status.source / status.mcpId", () => {
  it("register() defaults entries to source: 'yaml' (mcpId undefined)", () => {
    const supervisor = buildSupervisor();
    supervisor.register([yamlSpec]);
    const status = supervisor.statusList().find((s) => s.name === "yaml-mcp");
    expect(status?.source).toBe("yaml");
    expect(status?.mcpId).toBeUndefined();
  });

  it("registerOne() with no meta defaults to source: 'yaml'", () => {
    const supervisor = buildSupervisor();
    supervisor.registerOne(yamlSpec);
    const status = supervisor.statusList().find((s) => s.name === "yaml-mcp");
    expect(status?.source).toBe("yaml");
    expect(status?.mcpId).toBeUndefined();
  });

  it("registerOne() with meta.source: 'controller-config' + mcpId stamps both", () => {
    const supervisor = buildSupervisor();
    supervisor.registerOne(rosterSpec, { source: "controller-config", mcpId: "mcp_abc123" });
    const status = supervisor.statusList().find((s) => s.name === "roster-mcp");
    expect(status?.source).toBe("controller-config");
    expect(status?.mcpId).toBe("mcp_abc123");
  });

  it("registerOne() with meta.mcpId omitted leaves mcpId undefined even for controller-config source", () => {
    // Defensive: a coordinator regression that drops mcpId should NOT
    // smuggle empty-string in. The supervisor takes meta verbatim — no
    // synthetic ids.
    const supervisor = buildSupervisor();
    supervisor.registerOne(rosterSpec, { source: "controller-config" });
    const status = supervisor.statusList().find((s) => s.name === "roster-mcp");
    expect(status?.source).toBe("controller-config");
    expect(status?.mcpId).toBeUndefined();
  });

  it("statusList() returns a snapshot — mutating the returned array doesn't affect future calls", () => {
    const supervisor = buildSupervisor();
    supervisor.register([yamlSpec]);
    const first = supervisor.statusList();
    first[0].source = "controller-config" as const;
    const second = supervisor.statusList();
    expect(second[0].source).toBe("yaml");
  });

  it("register() defaults drop-in specs (carrying __dropin) to source: 'local'", () => {
    // W-L1: drop-in folders auto-discovered by src/dropin.ts get the
    // "local" badge so the inspector renders them distinctly from yaml-
    // listed (bundled) and controller-pushed entries.
    const dropinSpec: DropinSpec = {
      name: "drop-mcp",
      transport: "http",
      dir: "/var/synthetic/drop-mcp",
      timeout_ms: 5000,
      __dropin: true,
    };
    const supervisor = buildSupervisor();
    supervisor.register([dropinSpec]);
    const status = supervisor.statusList().find((s) => s.name === "drop-mcp");
    expect(status?.source).toBe("local");
  });

  it("registerOne() with no meta defaults a drop-in spec to source: 'local'", () => {
    const dropinSpec: DropinSpec = {
      name: "drop-mcp",
      transport: "http",
      dir: "/var/synthetic/drop-mcp",
      timeout_ms: 5000,
      __dropin: true,
    };
    const supervisor = buildSupervisor();
    supervisor.registerOne(dropinSpec);
    const status = supervisor.statusList().find((s) => s.name === "drop-mcp");
    expect(status?.source).toBe("local");
  });
});
