import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveCredsSource, type CredsSource } from "../../src/boot/creds-source.js";

describe("resolveCredsSource", () => {
  const originalEnv = process.env.CONNECTOR_CREDS_SOURCE;

  beforeEach(() => {
    delete process.env.CONNECTOR_CREDS_SOURCE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CONNECTOR_CREDS_SOURCE;
    } else {
      process.env.CONNECTOR_CREDS_SOURCE = originalEnv;
    }
  });

  it("returns 'db' when CONNECTOR_CREDS_SOURCE is unset", () => {
    delete process.env.CONNECTOR_CREDS_SOURCE;
    expect(resolveCredsSource()).toBe("db");
  });

  it("returns 'db' when CONNECTOR_CREDS_SOURCE is empty string", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "";
    expect(resolveCredsSource()).toBe("db");
  });

  it("returns 'env' when CONNECTOR_CREDS_SOURCE is 'env'", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "env";
    expect(resolveCredsSource()).toBe("env");
  });

  it("returns 'db' when CONNECTOR_CREDS_SOURCE is 'db'", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "db";
    expect(resolveCredsSource()).toBe("db");
  });

  it("throws for invalid value 'auto'", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "auto";
    expect(() => resolveCredsSource()).toThrow(/CONNECTOR_CREDS_SOURCE must be "env" or "db"/);
  });

  it("throws for invalid value 'both'", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "both";
    expect(() => resolveCredsSource()).toThrow(/CONNECTOR_CREDS_SOURCE must be "env" or "db"/);
  });

  it("throws for invalid value 'fallback'", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "fallback";
    expect(() => resolveCredsSource()).toThrow(/CONNECTOR_CREDS_SOURCE must be "env" or "db"/);
  });

  it("throws for uppercase ENV", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "ENV";
    expect(() => resolveCredsSource()).toThrow(/CONNECTOR_CREDS_SOURCE must be "env" or "db"/);
  });

  it("throws for uppercase DB", () => {
    process.env.CONNECTOR_CREDS_SOURCE = "DB";
    expect(() => resolveCredsSource()).toThrow(/CONNECTOR_CREDS_SOURCE must be "env" or "db"/);
  });
});
