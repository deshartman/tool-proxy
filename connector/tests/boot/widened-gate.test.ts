import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverBundled, EXAMPLE_MARKER } from "@connector/dropin.js";
import { buildManifest } from "@connector/manifest/build.js";
import { describeGated, announceDiscoveredDropins } from "@connector/boot/announce-dropins.js";
import { ApprovalCoordinator } from "@connector/tunnel/approval-coordinator.js";
import type { McpServerSpec, ConnectorConfig } from "@connector/config.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { McpSupervisor } from "@connector/mcp-supervisor.js";
import type { Logger } from "@connector/logger.js";
import type { McpDiscoveredFrame, TunnelFrame } from "@connector/tunnel/frames.js";

// MULTI-PLATFORM-MCP Phase 2c (decision D3): every MCP the connector runs
// itself ships available but INACTIVE — bundled, customer drop-in and yaml —
// and the controller operator enables each one. Controller-pushed (Type 2) MCPs
// stay outside the gate. The wire contract agreed with the platform:
//   mcp-discovered.author : string            ("twilio" | "customer" today)
//   mcp-discovered.source : "bundled" | "dropin" | "yaml"
//   mcp-discovered.kind   : "example"         (demos only, else absent)

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

function stub(name: string): McpServerConnection {
  return {
    name,
    transport: "http",
    listTools: async () => [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    listPrompts: async () => [],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    onNotification: () => () => undefined,
    close: async () => undefined,
  } as unknown as McpServerConnection;
}

describe("describeGated — wire values", () => {
  it("bundled (twilio-authored scan) → author twilio, source bundled", () => {
    const spec = { name: "agentic-memory", transport: "http", __dropin: true, __author: "twilio" } as unknown as McpServerSpec;
    expect(describeGated(spec, "bundled")).toEqual({ name: "agentic-memory", author: "twilio", source: "bundled" });
  });

  it("customer drop-in → author customer, source dropin (never the old 'local')", () => {
    const spec = { name: "crm", transport: "http", __dropin: true, __author: "customer" } as unknown as McpServerSpec;
    expect(describeGated(spec, "dropin")).toEqual({ name: "crm", author: "customer", source: "dropin" });
  });

  it("yaml entry → source yaml", () => {
    const spec = { name: "legacy", transport: "http", dir: "/x" } as unknown as McpServerSpec;
    expect(describeGated(spec, "yaml").source).toBe("yaml");
  });

  it("an example-marked spec carries kind: example; others carry no kind at all", () => {
    const demo = { name: "sample", transport: "http", __dropin: true, __author: "twilio", __example: true } as unknown as McpServerSpec;
    const prod = { name: "agentic-memory", transport: "http", __dropin: true, __author: "twilio" } as unknown as McpServerSpec;
    expect(describeGated(demo, "bundled").kind).toBe("example");
    expect("kind" in describeGated(prod, "bundled")).toBe(false);
  });
});

describe("example marker — scanner", () => {
  it("flags a bundled folder carrying .example, and only that folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "example-scan-"));
    for (const name of ["agentic-memory", "sample"]) {
      mkdirSync(join(dir, name, "tools"), { recursive: true });
      writeFileSync(join(dir, name, "tools", "t.ts"), "export default {};\n");
    }
    writeFileSync(join(dir, "sample", EXAMPLE_MARKER), "");
    const specs = discoverBundled({ bundledDir: dir, yamlNames: new Set() });
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect((byName.sample as { __example?: true }).__example).toBe(true);
    expect((byName["agentic-memory"] as { __example?: true }).__example).toBeUndefined();
  });

  it("every demo the repo ships carries the marker (the image copies them into bundled-mcps/)", () => {
    const demos = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/demos");
    for (const name of ["sample", "crm", "salesforce"]) {
      expect(existsSync(join(demos, name, EXAMPLE_MARKER)), `${name} is missing ${EXAMPLE_MARKER}`).toBe(true);
    }
  });
});

describe("manifest — bundled and yaml are withheld until enabled", () => {
  const config = { mcp_servers: [] } as unknown as ConnectorConfig;
  const servers = new Map([["agentic-memory", stub("agentic-memory")], ["legacy", stub("legacy")], ["pushed", stub("pushed")]]);
  // Gated = bundled + yaml. "pushed" is a Type 2 entry, so it is NOT in the map.
  const gated = new Map<string, unknown>([["agentic-memory", {}], ["legacy", {}]]);

  it("omits gated servers the controller has not approved, keeps Type 2", async () => {
    const manifest = await buildManifest(config, servers, "test", undefined, () => false, gated);
    expect(manifest.servers.map((s) => s.name)).toEqual(["pushed"]);
  });

  it("includes a gated server once approved", async () => {
    const manifest = await buildManifest(config, servers, "test", undefined, (n) => n === "agentic-memory", gated);
    expect(manifest.servers.map((s) => s.name).sort()).toEqual(["agentic-memory", "pushed"]);
  });
});

describe("mcp-discovered fan-out — every gated server, with its own values", () => {
  it("announces bundled, drop-in and yaml with the agreed author/source/kind", async () => {
    const sent: TunnelFrame[] = [];
    const supervisor = {
      statusList: () => [],
      fetchEnvKeys: async () => [],
    } as unknown as McpSupervisor;
    const approval = new ApprovalCoordinator({ send: (f) => { sent.push(f); }, supervisor, log: log(), onManifestChange: () => undefined });

    const result = await announceDiscoveredDropins({
      gated: [
        { name: "agentic-memory", author: "twilio", source: "bundled" },
        { name: "sample", author: "twilio", source: "bundled", kind: "example" },
        { name: "crm", author: "customer", source: "dropin" },
        { name: "legacy", author: "customer", source: "yaml" },
      ],
      approval,
      supervisor,
      servers: new Map([["agentic-memory", stub("agentic-memory")], ["sample", stub("sample")], ["crm", stub("crm")], ["legacy", stub("legacy")]]),
      log: log(),
    });

    expect(result).toEqual({ announced: 4, totalDropins: 4 });
    const frames = sent.filter((f): f is McpDiscoveredFrame => f.type === "mcp-discovered");
    const byMcp = Object.fromEntries(frames.map((f) => [f.mcp, f]));
    expect(byMcp["agentic-memory"]).toMatchObject({ author: "twilio", source: "bundled" });
    expect(byMcp["agentic-memory"].kind).toBeUndefined();
    expect(byMcp.sample).toMatchObject({ author: "twilio", source: "bundled", kind: "example" });
    expect(byMcp.crm).toMatchObject({ author: "customer", source: "dropin" });
    expect(byMcp.legacy).toMatchObject({ author: "customer", source: "yaml" });
    // Never the pre-2c literal: the platform keys "this shim is gated" off it.
    expect(frames.some((f) => (f.source as string) === "local")).toBe(false);
  });
});
