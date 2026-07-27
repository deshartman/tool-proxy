import { describe, it, expect } from "vitest";
import { requireEnv } from "../../src/boot/require-env.js";

// Post env-mode-removal: requireEnv only requires POSTGRES_URL + CONNECTOR_KEY_FILE.
// Tunnel identity + creds now live in the sealed controllers row and are managed
// through the inspector Configure Tunnel UI — not env vars.

describe("requireEnv — db-mode preflight (only mode)", () => {
  const validEnv = (): NodeJS.ProcessEnv => ({
    POSTGRES_URL: "postgres://mcp:pass@localhost:5432/mcp",
    CONNECTOR_KEY_FILE: "/etc/mcp-connector/connector.key",
  });

  it("returns cleanly when both required vars are set", () => {
    expect(() => requireEnv(validEnv())).not.toThrow();
  });

  it("throws with POSTGRES_URL in the message when it's missing", () => {
    const env = validEnv();
    delete env.POSTGRES_URL;
    expect(() => requireEnv(env)).toThrow(/POSTGRES_URL is required/);
  });

  it("throws with CONNECTOR_KEY_FILE in the message when it's missing", () => {
    const env = validEnv();
    delete env.CONNECTOR_KEY_FILE;
    expect(() => requireEnv(env)).toThrow(/CONNECTOR_KEY_FILE is required/);
  });

  it("throws with both names when both are missing", () => {
    const env: NodeJS.ProcessEnv = {};
    let caught: Error | undefined;
    try { requireEnv(env); } catch (e) { caught = e as Error; }
    expect(caught?.message).toMatch(/POSTGRES_URL is required/);
    expect(caught?.message).toMatch(/CONNECTOR_KEY_FILE is required/);
  });

  it("treats empty-string as unset (blank-line .env semantics)", () => {
    const env: NodeJS.ProcessEnv = { POSTGRES_URL: "", CONNECTOR_KEY_FILE: "" };
    expect(() => requireEnv(env)).toThrow(/POSTGRES_URL is required/);
  });
});

describe("requireEnv — CONNECTOR_CONFIG default", () => {
  it("sets CONNECTOR_CONFIG to ./connector.yaml when unset", () => {
    const env: NodeJS.ProcessEnv = {
      POSTGRES_URL: "postgres://mcp:pass@localhost:5432/mcp",
      CONNECTOR_KEY_FILE: "/etc/mcp-connector/connector.key",
    };
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("sets CONNECTOR_CONFIG to ./connector.yaml when empty-string", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "",
      POSTGRES_URL: "postgres://mcp:pass@localhost:5432/mcp",
      CONNECTOR_KEY_FILE: "/etc/mcp-connector/connector.key",
    };
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("preserves an explicit CONNECTOR_CONFIG value", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "/custom/path/connector.yaml",
      POSTGRES_URL: "postgres://mcp:pass@localhost:5432/mcp",
      CONNECTOR_KEY_FILE: "/etc/mcp-connector/connector.key",
    };
    requireEnv(env);
    expect(env.CONNECTOR_CONFIG).toBe("/custom/path/connector.yaml");
  });
});
