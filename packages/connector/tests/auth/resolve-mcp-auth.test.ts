import { describe, it, expect } from "vitest";

import { resolveAuthHeaders, isSyncResolvable } from "../../src/auth/resolve-mcp-auth.js";
import type { McpAuthSpec } from "../../src/tunnel/frames.js";

// Pin the resolver helper as the contract for W-E3 (none / bearer / header)
// and the sync-vs-async classification used by the supervisor to decide
// whether to await an OAuth2 mint. Speculative integration tests against
// the supervisor are deliberately omitted — TEST-SUITE.md is regression-
// driven and no manual finding has surfaced a supervisor-level bug here yet.

describe("resolveAuthHeaders — none", () => {
  it("returns empty headers + empty missing keys", () => {
    const result = resolveAuthHeaders({ kind: "none" }, {});
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual([]);
  });

  it("ignores any env values that happen to be present", () => {
    const result = resolveAuthHeaders({ kind: "none" }, { ANYTHING: "ignored" });
    expect(result.headers).toEqual({});
  });
});

describe("resolveAuthHeaders — bearer", () => {
  const auth: McpAuthSpec = { kind: "bearer", envKey: "MCP_BEARER" };

  it("emits Authorization: Bearer <value> when the env key is populated", () => {
    const result = resolveAuthHeaders(auth, { MCP_BEARER: "tok_abc" });
    expect(result.headers).toEqual({ Authorization: "Bearer tok_abc" });
    expect(result.missingEnvKeys).toEqual([]);
  });

  it("reports the missing key when env is empty (does not throw)", () => {
    const result = resolveAuthHeaders(auth, {});
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual(["MCP_BEARER"]);
  });

  it("treats an empty-string value as missing (matches stripEmptyValues at the wire)", () => {
    // Defensive: stripEmptyValues at the creds-coordinator boundary should
    // already drop empty-string keys, but if a controller-side regression
    // sneaks one through, the resolver must not emit a bogus
    // `Authorization: Bearer ` header.
    const result = resolveAuthHeaders(auth, { MCP_BEARER: "" });
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual(["MCP_BEARER"]);
  });
});

describe("resolveAuthHeaders — header", () => {
  const auth: McpAuthSpec = {
    kind: "header",
    headerName: "X-API-Key",
    envKey: "MCP_API_KEY",
  };

  it("emits the named header verbatim when env is populated", () => {
    const result = resolveAuthHeaders(auth, { MCP_API_KEY: "sk_live_xyz" });
    expect(result.headers).toEqual({ "X-API-Key": "sk_live_xyz" });
    expect(result.missingEnvKeys).toEqual([]);
  });

  it("preserves non-canonical header casing as supplied by the controller", () => {
    // The wire spec does not normalize header names — operator types
    // "X-API-Key" or "x-api-key" and the upstream sees what they typed.
    // Pin the verbatim behavior so a future "be helpful and Title-Case it"
    // refactor can't silently break a header-sensitive upstream.
    const lower: McpAuthSpec = {
      kind: "header",
      headerName: "x-api-key",
      envKey: "MCP_API_KEY",
    };
    const result = resolveAuthHeaders(lower, { MCP_API_KEY: "v" });
    expect(result.headers).toEqual({ "x-api-key": "v" });
  });

  it("reports the missing key when env is empty", () => {
    const result = resolveAuthHeaders(auth, {});
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual(["MCP_API_KEY"]);
  });
});

describe("resolveAuthHeaders — oauth2 (sync resolver returns nothing)", () => {
  // The sync resolver is NOT the entrypoint for OAuth2 — that's
  // resolve-mcp-auth-async.ts. Calling resolveAuthHeaders() on an OAuth2
  // spec should not throw, and should NOT emit a partial/wrong header
  // (e.g. "Authorization: Bearer <clientId>" would be a serious bug).
  // The supervisor's branch on isSyncResolvable() is what routes OAuth2
  // to the async helper.
  it("returns empty headers for oauth2-client-credentials (caller must use async path)", () => {
    const auth: McpAuthSpec = {
      kind: "oauth2-client-credentials",
      tokenUrlEnvKey: "MCP_TOKEN_URL",
      clientIdEnvKey: "MCP_CLIENT_ID",
      clientSecretEnvKey: "MCP_CLIENT_SECRET",
    };
    const env = {
      MCP_TOKEN_URL: "https://oauth.example.com/token",
      MCP_CLIENT_ID: "id",
      MCP_CLIENT_SECRET: "sec",
    };
    const result = resolveAuthHeaders(auth, env);
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual([]);
  });
});

describe("isSyncResolvable", () => {
  it("returns true for none / bearer / header", () => {
    expect(isSyncResolvable({ kind: "none" })).toBe(true);
    expect(isSyncResolvable({ kind: "bearer", envKey: "X" })).toBe(true);
    expect(isSyncResolvable({ kind: "header", headerName: "X", envKey: "Y" })).toBe(true);
  });

  it("returns false for oauth2 — supervisor must route to async helper", () => {
    expect(
      isSyncResolvable({
        kind: "oauth2-client-credentials",
        tokenUrlEnvKey: "T",
        clientIdEnvKey: "I",
        clientSecretEnvKey: "S",
      }),
    ).toBe(false);
  });
});
