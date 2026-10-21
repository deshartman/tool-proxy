import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { McpSupervisor } from "../../src/mcp-supervisor.js";
import type { McpServerSpec } from "../../src/config.js";

// MCP-AUDIT #2 — the connector must not hand its own secrets to a spawned
// child by inheritance.
//
// boot/require-env.ts requires exactly two env vars and both are secrets or
// paths to secrets: POSTGRES_URL (the DSN *with the password* for the database
// holding the sealed `controllers` row) and CONNECTOR_KEY_FILE (the 32-byte
// libsodium master key that seals it). Children run as the SAME uid as the
// connector, so a child that learns the key path can read it and decrypt the
// tunnel bearer.
//
// The subtle half — and the reason this test exists rather than a source
// grep — is SCOPE. The filter applies to the process.env INHERITANCE layer
// only. A later layer (dir/.env, session creds, controller-pushed creds) may
// still set the same key, because there it is a deliberate act: a customer MCP
// that genuinely wants its own POSTGRES_URL must keep working. Both halves are
// pinned below; a fix that over-corrects into a blanket ban fails the second
// describe block.

type MergeEnv = (
  entry: unknown,
  sources: Record<string, string>,
  extras: Record<string, string>,
) => NodeJS.ProcessEnv;

interface SupervisorPrivates {
  mergeEnv: MergeEnv;
  entries: Map<string, unknown>;
}

const SECRET_KEYS = [
  "POSTGRES_URL",
  "POSTGRES_URL_TEMPLATE",
  "POSTGRES_PW_FILE",
  "POSTGRES_SCHEMA",
  "CONNECTOR_KEY_FILE",
  "CONNECTOR_KEY_B64",
] as const;

function buildSupervisor(): SupervisorPrivates {
  const log = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: "info",
    child: () => log,
  } as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  const supervisor = new McpSupervisor({ log, servers: new Map() });
  return supervisor as unknown as SupervisorPrivates;
}

// Register a spec and hand back the private Entry mergeEnv expects.
function entryFor(
  privates: SupervisorPrivates,
  spec: Partial<McpServerSpec> & { name: string },
): unknown {
  const full = { transport: "http", dir: "/dev/null", ...spec } as unknown as McpServerSpec;
  (privates as unknown as McpSupervisor).register([full]);
  return privates.entries.get(spec.name);
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SECRET_KEYS) saved[k] = process.env[k];
  saved.BENIGN_PASSTHROUGH = process.env.BENIGN_PASSTHROUGH;
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("MCP-AUDIT #2 — connector-only secrets are not inherited by children", () => {
  it("strips every connector-only key from the process.env layer", () => {
    for (const k of SECRET_KEYS) process.env[k] = `secret-value-for-${k}`;
    process.env.BENIGN_PASSTHROUGH = "keep-me";

    const privates = buildSupervisor();
    const entry = entryFor(privates, { name: "victim" });
    const sources: Record<string, string> = {};
    const merged = privates.mergeEnv(entry, sources, {});

    for (const k of SECRET_KEYS) {
      expect(merged[k], `${k} must not reach the child`).toBeUndefined();
      expect(sources[k], `${k} must not appear in the env-source telemetry`).toBeUndefined();
    }
    // The filter must be surgical, not a blanket empty env.
    expect(merged.BENIGN_PASSTHROUGH).toBe("keep-me");
    expect(sources.BENIGN_PASSTHROUGH).toBe("process.env");
  });

  it("does not leak a secret value anywhere in the merged env, under any key", () => {
    // Guards against a future "rename instead of strip" regression.
    process.env.POSTGRES_URL = "postgres://mcp:s3cr3t-pw@db:5432/mcp_connector";
    const privates = buildSupervisor();
    const entry = entryFor(privates, { name: "victim" });
    const merged = privates.mergeEnv(entry, {}, {});

    const values = Object.values(merged).filter((v): v is string => typeof v === "string");
    expect(values.some((v) => v.includes("s3cr3t-pw"))).toBe(false);
  });

  it("still injects MCP_WEBHOOK_TOKEN (the filter must not disturb it)", () => {
    const privates = buildSupervisor();
    const entry = entryFor(privates, { name: "victim" });
    const merged = privates.mergeEnv(entry, {}, {});
    expect(merged.MCP_WEBHOOK_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("MCP-AUDIT #2 — SCOPE: deliberate layers may still set these keys", () => {
  it("honours a POSTGRES_URL the MCP set itself via dir/.env (spec.env)", () => {
    process.env.POSTGRES_URL = "postgres://connector-own-dsn";
    const privates = buildSupervisor();
    const entry = entryFor(privates, {
      name: "byo-db",
      env: { POSTGRES_URL: "postgres://the-mcps-own-db" },
    } as Partial<McpServerSpec> & { name: string });

    const sources: Record<string, string> = {};
    const merged = privates.mergeEnv(entry, sources, {});

    // The MCP's own value wins; the connector's is never visible.
    expect(merged.POSTGRES_URL).toBe("postgres://the-mcps-own-db");
    expect(sources.POSTGRES_URL).toBe("dir/.env");
  });

  it("honours a controller-pushed value (highest layer)", () => {
    process.env.CONNECTOR_KEY_FILE = "/etc/tool-proxy/connector.key";
    const privates = buildSupervisor();
    const entry = entryFor(privates, { name: "controller-fed" }) as {
      controllerEnv: Record<string, string>;
    };
    entry.controllerEnv = { CONNECTOR_KEY_FILE: "/deliberate/override" };

    const sources: Record<string, string> = {};
    const merged = privates.mergeEnv(entry, sources, {});
    expect(merged.CONNECTOR_KEY_FILE).toBe("/deliberate/override");
    expect(sources.CONNECTOR_KEY_FILE).toBe("controller");
  });
});
