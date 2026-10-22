import { describe, it, expect } from "vitest";
import { requireEnv } from "../../src/boot/require-env.js";

// Post DB-TO-FILE: CONNECTOR_KEY_FILE is the ONLY required env var. The config
// store is a sealed JSON file on the state volume, so there is no DSN to supply;
// tunnel identity + creds live in that store and are managed through the
// inspector's Configure Tunnel UI.
//
// One requirement is the floor, not a preference: the process needs the master
// key to open the sealed store before it can serve the UI that would otherwise
// supply everything else.

describe("requireEnv — preflight", () => {
  const validEnv = (): NodeJS.ProcessEnv => ({
    CONNECTOR_KEY_FILE: "/etc/tool-proxy/connector.key",
  });

  it("returns cleanly when the master key path is set", () => {
    expect(() => requireEnv(validEnv())).not.toThrow();
  });

  it("throws with CONNECTOR_KEY_FILE in the message when it's missing", () => {
    const env = validEnv();
    delete env.CONNECTOR_KEY_FILE;
    expect(() => requireEnv(env)).toThrow(/CONNECTOR_KEY_FILE is required/);
  });

  it("treats empty-string as unset (blank-line .env semantics)", () => {
    const env: NodeJS.ProcessEnv = { CONNECTOR_KEY_FILE: "" };
    expect(() => requireEnv(env)).toThrow(/CONNECTOR_KEY_FILE is required/);
  });

  // Pins the removal, not just the current state. A leftover POSTGRES_URL in a
  // customer's .env after upgrading must be inert — neither required nor
  // rejected — so an upgrade doesn't fail on stale config, and so nobody
  // reintroduces the requirement by reflex.
  it("ignores a leftover POSTGRES_URL entirely", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_KEY_FILE: "/etc/tool-proxy/connector.key",
      POSTGRES_URL: "postgres://mcp:pass@localhost:5432/mcp",
    };
    expect(() => requireEnv(env)).not.toThrow();
  });

  it("does not mention POSTGRES_URL when it fails", () => {
    let caught: Error | undefined;
    try {
      requireEnv({});
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toMatch(/CONNECTOR_KEY_FILE is required/);
    expect(caught?.message).not.toMatch(/POSTGRES/);
  });
});

describe("requireEnv — CONNECTOR_CONFIG default", () => {
  const withKey = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    CONNECTOR_KEY_FILE: "/etc/tool-proxy/connector.key",
    ...extra,
  });

  it("sets CONNECTOR_CONFIG to ./connector.yaml when unset", () => {
    const env = withKey();
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("sets CONNECTOR_CONFIG to ./connector.yaml when empty-string", () => {
    const env = withKey({ CONNECTOR_CONFIG: "" });
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("preserves an explicit CONNECTOR_CONFIG value", () => {
    const env = withKey({ CONNECTOR_CONFIG: "/custom/path/connector.yaml" });
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("/custom/path/connector.yaml");
  });
});
