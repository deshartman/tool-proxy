import { describe, it, expect } from "vitest";

import { buildManifest, dropinSpecsToMap } from "@connector/manifest/build.js";
import type { ConnectorConfig } from "@connector/config.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { DropinSpec } from "@connector/dropin.js";

// v1.3 — Customer drop-in approval gate. The manifest-build path is the
// physical gate: a drop-in MCP whose name is NOT in `isApproved` is omitted
// from the ServerDescriptor list entirely. Yaml-listed and controller-config
// entries are not gated regardless of what `isApproved` returns — the gate
// predicate is "spec is a drop-in" (carries `__dropin: true`), not "any
// spec the supervisor knows about".
//
// Pinned invariants:
//   * Drop-in NOT approved → omitted from manifest.servers entirely.
//   * Drop-in approved → included with full tool descriptors (the schemas
//     that mcp-discovered deliberately withheld).
//   * Yaml-listed entry is included regardless of isApproved (yaml is the
//     existing acceptance gesture per DA7).
//   * Without `isApproved` callback, every entry is included (preserves
//     pre-v1.3 boot paths and tests).

const sampleConfig: ConnectorConfig = {
  tunnel: { controller_url: "http://localhost:0", name: "test", environment: "test" },
  mcp_servers: [{ name: "twilio", transport: "http", dir: "../../mcp/bundled/twilio" }],
  policy: {
    max_concurrent_calls: 1,
    log_tool_args: false,
    tool_timeout_ms: 1000,
    heartbeat_interval_ms: 1000,
    reconnect: { enabled: false, initial_backoff_ms: 1, max_backoff_ms: 1 },
  },
} as unknown as ConnectorConfig;

function fakeConnection(name: string): McpServerConnection {
  return {
    name,
    transport: "http",
    capabilities: undefined,
    listTools: async () => [
      { name: `${name}_tool_a`, description: "a", inputSchema: { type: "object" } },
      { name: `${name}_tool_b`, description: "b", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({}),
    listPrompts: async () => [],
    getPrompt: async () => ({}),
    listResources: async () => [],
    listResourceTemplates: async () => [],
    readResource: async () => ({}),
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
    complete: async () => ({}),
    setLoggingLevel: async () => ({}),
    onNotification: () => {},
    close: async () => {},
  } as unknown as McpServerConnection;
}

function dropinSpec(name: string): DropinSpec {
  // Match the shape produced by discoverDropins: Type 1 http + dir + the
  // hidden __dropin marker. The dropinSpecsToMap helper checks for the
  // marker via isDropinSpec.
  return { name, transport: "http", dir: `/tmp/dropins/${name}`, __dropin: true } as unknown as DropinSpec;
}

describe("buildManifest approval gate (v1.3)", () => {
  it("omits a drop-in MCP whose name is NOT in isApproved", async () => {
    const servers = new Map<string, McpServerConnection>([
      ["crm", fakeConnection("crm")],
      ["twilio", fakeConnection("twilio")],
    ]);
    const dropinMap = dropinSpecsToMap([dropinSpec("crm")]);

    const manifest = await buildManifest(
      sampleConfig,
      servers,
      "test",
      "/tmp/connector.yaml",
      undefined,
      (name) => name !== "crm", // crm is unapproved
      dropinMap,
    );

    const names = manifest.servers.map((s) => s.name);
    expect(names).not.toContain("crm");
    expect(names).toContain("twilio"); // yaml-listed; never gated
  });

  it("includes a drop-in MCP with full tool descriptors when approved", async () => {
    const servers = new Map<string, McpServerConnection>([["crm", fakeConnection("crm")]]);
    const dropinMap = dropinSpecsToMap([dropinSpec("crm")]);

    const manifest = await buildManifest(
      {
        ...sampleConfig,
        mcp_servers: [],
      } as unknown as ConnectorConfig,
      servers,
      "test",
      "/tmp/connector.yaml",
      undefined,
      () => true,
      dropinMap,
    );

    expect(manifest.servers).toHaveLength(1);
    const crm = manifest.servers[0];
    expect(crm.name).toBe("crm");
    // Critical: schemas land here (which `mcp-discovered` withheld). The
    // gate is binary: omit-or-include — never partial.
    expect(crm.tools.map((t) => t.name)).toEqual(["crm_tool_a", "crm_tool_b"]);
    expect(crm.tools[0].inputSchema).toBeDefined();
  });

  it("includes a yaml-listed MCP regardless of isApproved (DA7)", async () => {
    const servers = new Map<string, McpServerConnection>([["twilio", fakeConnection("twilio")]]);
    // dropinMap is empty: yaml-listed entries don't appear in the
    // discoverDropins() output, so the gate never asks isApproved about
    // them. Even an isApproved that always returns false must NOT remove
    // the yaml entry.
    const dropinMap = dropinSpecsToMap([]);

    const manifest = await buildManifest(
      sampleConfig,
      servers,
      "test",
      "/tmp/connector.yaml",
      undefined,
      () => false,
      dropinMap,
    );

    expect(manifest.servers.map((s) => s.name)).toEqual(["twilio"]);
  });

  it("includes everything when isApproved is omitted (preserves pre-v1.3 boot)", async () => {
    const servers = new Map<string, McpServerConnection>([
      ["crm", fakeConnection("crm")],
      ["twilio", fakeConnection("twilio")],
    ]);
    const dropinMap = dropinSpecsToMap([dropinSpec("crm")]);

    const manifest = await buildManifest(
      sampleConfig,
      servers,
      "test",
      "/tmp/connector.yaml",
      undefined,
      undefined, // omitted
      dropinMap,
    );

    // Both entries land in the manifest — proves the gate is opt-in. A
    // boot path that hasn't been updated to thread through `isApproved`
    // continues to work as it did pre-v1.3.
    expect(manifest.servers.map((s) => s.name).sort()).toEqual(["crm", "twilio"]);
  });

  it("includes everything when dropinSpecsByName is omitted (no drop-ins to gate)", async () => {
    const servers = new Map<string, McpServerConnection>([["twilio", fakeConnection("twilio")]]);

    const manifest = await buildManifest(
      sampleConfig,
      servers,
      "test",
      "/tmp/connector.yaml",
      undefined,
      () => false, // would gate everything if classified as drop-in
      undefined,   // but no specs are classified
    );

    // No spec is classified as a drop-in, so the gate never fires.
    expect(manifest.servers.map((s) => s.name)).toEqual(["twilio"]);
  });

  it("dropinSpecsToMap filters out non-drop-in specs (defensive)", () => {
    const dropin: DropinSpec = { name: "crm", transport: "http", dir: "/tmp/crm", __dropin: true } as unknown as DropinSpec;
    const yaml = { name: "twilio", transport: "http", dir: "../../mcp/bundled/twilio" };
    const map = dropinSpecsToMap([dropin, yaml]);
    expect(map.has("crm")).toBe(true);
    expect(map.has("twilio")).toBe(false);
  });
});
