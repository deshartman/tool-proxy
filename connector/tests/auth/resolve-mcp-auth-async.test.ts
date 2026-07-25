import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  resolveOAuthBearer,
  type OAuthProviderCache,
} from "../../src/auth/resolve-mcp-auth-async.js";
import type { McpAuthSpec } from "../../src/tunnel/frames.js";

// Pin the OAuth2 client_credentials resolver. The mint-at-connect /
// restart-on-401 strategy means most of the surface is the cache: two MCPs
// with identical creds reuse one provider, a creds-update that changes
// any of (tokenUrl, clientId, clientSecret) invalidates the slot, and a
// mint failure drops the cached provider so the next attempt is fresh.
//
// We mock global fetch to avoid network and to assert request shape.

const auth: Extract<McpAuthSpec, { kind: "oauth2-client-credentials" }> = {
  kind: "oauth2-client-credentials",
  tokenUrlEnvKey: "MCP_OAUTH_TOKEN_URL",
  clientIdEnvKey: "MCP_OAUTH_CLIENT_ID",
  clientSecretEnvKey: "MCP_OAUTH_CLIENT_SECRET",
};

const goodEnv = {
  MCP_OAUTH_TOKEN_URL: "https://oauth.example.com/token",
  MCP_OAUTH_CLIENT_ID: "id_abc",
  MCP_OAUTH_CLIENT_SECRET: "sec_xyz",
};

function mockFetchOk(body: { access_token: string; token_type: string; expires_in: number }): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
  // Cast to globalThis.fetch's signature.
  (globalThis as unknown as { fetch: typeof fn }).fetch = fn;
  return fn;
}

function mockFetchError(status: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  });
  (globalThis as unknown as { fetch: typeof fn }).fetch = fn;
  return fn;
}

describe("resolveOAuthBearer", () => {
  let cache: OAuthProviderCache;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    cache = new Map();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("mints a JWT and emits Authorization: Bearer when env is fully populated", async () => {
    mockFetchOk({ access_token: "jwt_abc", token_type: "Bearer", expires_in: 3600 });
    const result = await resolveOAuthBearer(auth, goodEnv, cache);
    expect(result.headers).toEqual({ Authorization: "Bearer jwt_abc" });
    expect(result.missingEnvKeys).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("reports missing keys (does not throw, does not call fetch) when any of the three is empty", async () => {
    const fetchFn = mockFetchOk({ access_token: "x", token_type: "Bearer", expires_in: 3600 });
    const partial = { ...goodEnv, MCP_OAUTH_CLIENT_SECRET: "" };
    const result = await resolveOAuthBearer(auth, partial, cache);
    expect(result.headers).toEqual({});
    expect(result.missingEnvKeys).toEqual(["MCP_OAUTH_CLIENT_SECRET"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports ALL missing keys when several are empty (single-pass diagnostic)", async () => {
    mockFetchOk({ access_token: "x", token_type: "Bearer", expires_in: 3600 });
    const result = await resolveOAuthBearer(auth, {}, cache);
    expect(result.missingEnvKeys.sort()).toEqual([
      "MCP_OAUTH_CLIENT_ID",
      "MCP_OAUTH_CLIENT_SECRET",
      "MCP_OAUTH_TOKEN_URL",
    ]);
  });

  it("reuses the cached provider when called twice with identical env (no second fetch)", async () => {
    const fetchFn = mockFetchOk({ access_token: "jwt_first", token_type: "Bearer", expires_in: 3600 });
    const a = await resolveOAuthBearer(auth, goodEnv, cache);
    const b = await resolveOAuthBearer(auth, goodEnv, cache);
    expect(a.headers).toEqual({ Authorization: "Bearer jwt_first" });
    expect(b.headers).toEqual({ Authorization: "Bearer jwt_first" });
    // The provider's <60s pre-expiry refresh logic means a second
    // accessToken() call within the cached window does NOT fetch again.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("creates a SEPARATE cache slot when clientId changes (creds-update path)", async () => {
    mockFetchOk({ access_token: "jwt_a", token_type: "Bearer", expires_in: 3600 });
    await resolveOAuthBearer(auth, goodEnv, cache);
    const env2 = { ...goodEnv, MCP_OAUTH_CLIENT_ID: "id_rotated" };
    await resolveOAuthBearer(auth, env2, cache);
    expect(cache.size).toBe(2);
  });

  it("creates a SEPARATE cache slot when clientSecret changes", async () => {
    mockFetchOk({ access_token: "jwt_a", token_type: "Bearer", expires_in: 3600 });
    await resolveOAuthBearer(auth, goodEnv, cache);
    const env2 = { ...goodEnv, MCP_OAUTH_CLIENT_SECRET: "sec_rotated" };
    await resolveOAuthBearer(auth, env2, cache);
    expect(cache.size).toBe(2);
  });

  it("creates a SEPARATE cache slot when tokenUrl changes (Twilio takeover migration)", async () => {
    mockFetchOk({ access_token: "jwt_a", token_type: "Bearer", expires_in: 3600 });
    await resolveOAuthBearer(auth, goodEnv, cache);
    const env2 = { ...goodEnv, MCP_OAUTH_TOKEN_URL: "https://oauth.twilio.com/v2/token" };
    await resolveOAuthBearer(auth, env2, cache);
    expect(cache.size).toBe(2);
  });

  it("evicts the cached provider on token mint failure so the next call mints fresh", async () => {
    mockFetchError(401);
    const a = await resolveOAuthBearer(auth, goodEnv, cache);
    expect(a.headers).toEqual({});
    expect(a.error).toMatch(/401/);
    expect(cache.size).toBe(0);

    // Next call: server has been fixed, mint succeeds.
    mockFetchOk({ access_token: "jwt_recovered", token_type: "Bearer", expires_in: 3600 });
    const b = await resolveOAuthBearer(auth, goodEnv, cache);
    expect(b.headers).toEqual({ Authorization: "Bearer jwt_recovered" });
    expect(b.error).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("never includes the client_secret in the returned error string", async () => {
    // Defence-in-depth: a future provider tweak that surfaces upstream
    // error bodies must not echo the secret. The provider's current
    // throw is `OAuth token mint failed: 401`; we pin that no part of
    // the secret leaks through.
    mockFetchError(401);
    const result = await resolveOAuthBearer(auth, goodEnv, cache);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("sec_xyz");
    expect(result.error).not.toContain("id_abc");
  });

  it("posts grant_type=client_credentials with form-urlencoded body to the controller-supplied tokenUrl", async () => {
    const fetchFn = mockFetchOk({ access_token: "jwt", token_type: "Bearer", expires_in: 3600 });
    await resolveOAuthBearer(auth, goodEnv, cache);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: URLSearchParams }];
    expect(url).toBe(goodEnv.MCP_OAUTH_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = init.body.toString();
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain(`client_id=${encodeURIComponent(goodEnv.MCP_OAUTH_CLIENT_ID)}`);
    expect(body).toContain(`client_secret=${encodeURIComponent(goodEnv.MCP_OAUTH_CLIENT_SECRET)}`);
  });
});
