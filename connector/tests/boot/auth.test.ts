import { describe, it, expect, vi } from "vitest";

import { resolveAuthFromEnv } from "../../src/boot/auth.js";
import { OAuthClientCredentialsProvider } from "../../src/auth/oauth-provider.js";

// resolveAuthFromEnv is the auth-posture dispatcher — pure function over an
// injected env map. The user-facing missing-env scenarios (OAUTH_CLIENT_ID
// set but OAUTH_CLIENT_SECRET missing, neither posture configured, etc.)
// are now covered by tests/boot/require-env.test.ts because requireEnv()
// runs first at boot and intercepts those paths with a consolidated error.
//
// What remains here is resolveAuth's pure-function contract: given valid
// inputs, what does it return? The throws inside resolveAuth are still
// reachable when callers invoke it directly (tests, future callers without
// requireEnv() upstream), so we keep one structural test for the
// fail-fast path — but we don't enumerate every missing-OAUTH-var case
// because that's requireEnv's job now.

describe("resolveAuthFromEnv — pure-function contract", () => {
  it("returns an OAuthClientCredentialsProvider when all three OAUTH_* vars are set", () => {
    const env = {
      OAUTH_CLIENT_ID: "client_test",
      OAUTH_CLIENT_SECRET: "secret_test",
      OAUTH_TOKEN_URL: "https://oauth.example.com/token",
    } as NodeJS.ProcessEnv;

    const result = resolveAuthFromEnv(undefined, env);

    expect(result.authToken).toBeUndefined();
    expect(result.authProvider).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(result.status).toBe("oauth2 (clientId=client_test)");
  });

  it("returns the configAuthToken with status reporting only its length (no secret leak)", () => {
    // Security invariant: the operator-facing `status` string flows into
    // boot logs and the inspector header. Refactor that includes the token
    // bytes for "easier debugging" silently leaks ts_<rowId>_<random>
    // into screenshots and log shipping. Length-only is load-bearing.
    const env = {} as NodeJS.ProcessEnv;
    const sensitive = "ts_secret_value_should_never_appear_in_logs";

    const result = resolveAuthFromEnv(sensitive, env);

    expect(result.authProvider).toBeUndefined();
    expect(result.authToken).toBe(sensitive);
    expect(result.status).toBe(`set (len=${sensitive.length})`);
    expect(result.status).not.toContain(sensitive);
    expect(result.status).not.toContain("secret");
  });

  it("dispatches OAuth2 when OAUTH_CLIENT_ID is set even if a configAuthToken is also provided", () => {
    // Posture priority is structural: OAUTH_CLIENT_ID presence wins. Pin
    // the dispatch rule so a refactor doesn't silently swap to "static
    // bearer wins" while the operator's blank-line OAUTH config sits unused.
    const env = {
      OAUTH_CLIENT_ID: "client_test",
      OAUTH_CLIENT_SECRET: "secret_test",
      OAUTH_TOKEN_URL: "https://oauth.example.com/token",
    } as NodeJS.ProcessEnv;

    const result = resolveAuthFromEnv("ts_static_fallback", env);

    expect(result.authProvider).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(result.authToken).toBeUndefined();
  });

  it("throws fail-fast when neither posture is configured (defensive guard for direct callers)", () => {
    // requireEnv() catches this at boot, but resolveAuth is callable
    // independently. The throw stays as a structural total-function-ness
    // guarantee — caller gets a well-typed error rather than `undefined`
    // flowing into TunnelClient.
    const env = {} as NodeJS.ProcessEnv;

    expect(() => resolveAuthFromEnv(undefined, env)).toThrow(/tunnel auth missing/);
  });

  it("default-arg branch — falls back to process.env when no env map is passed", () => {
    vi.stubEnv("OAUTH_CLIENT_ID", "client_from_process_env");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "secret_from_process_env");
    vi.stubEnv("OAUTH_TOKEN_URL", "https://oauth.example.com/token");

    const result = resolveAuthFromEnv(undefined);

    expect(result.authProvider).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(result.status).toContain("client_from_process_env");
  });
});
