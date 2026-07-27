import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthClientCredentialsProvider } from "../../src/auth/oauth-provider.js";

// C6 + C9 — single-flight refresh + defensive access_token validation
// for the OAuth2 client_credentials provider used on WS-handshake auth.

describe("OAuthClientCredentialsProvider — C9 access_token validation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const stubFetch = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  };

  it("rejects missing access_token", async () => {
    stubFetch({ expires_in: 3600 });
    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).rejects.toThrow(/invalid access_token/);
  });

  it("rejects null access_token", async () => {
    stubFetch({ expires_in: 3600, access_token: null });
    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).rejects.toThrow(/invalid access_token/);
  });

  it("rejects empty-string access_token", async () => {
    stubFetch({ expires_in: 3600, access_token: "" });
    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).rejects.toThrow(/invalid access_token/);
  });

  it("rejects number access_token", async () => {
    stubFetch({ expires_in: 3600, access_token: 42 });
    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).rejects.toThrow(/invalid access_token/);
  });

  it("accepts a well-formed response", async () => {
    stubFetch({ expires_in: 3600, access_token: "jwt.abc.def" });
    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).resolves.toBe("jwt.abc.def");
  });
});

describe("OAuthClientCredentialsProvider — C6 single-flight refresh", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("concurrent calls near-simultaneous mint fire only ONE fetch", async () => {
    let fetchCount = 0;
    let resolveResponse: (() => void) | undefined;
    const pending = new Promise<void>((r) => { resolveResponse = r; });

    globalThis.fetch = (async () => {
      fetchCount++;
      await pending;  // hold every fetch open until we release
      return new Response(JSON.stringify({ access_token: "jwt.1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    // Fire 5 concurrent calls before releasing the mock
    const promises = [p.accessToken(), p.accessToken(), p.accessToken(), p.accessToken(), p.accessToken()];
    // Yield to let all callers reach the fetch (or await the shared promise)
    await new Promise((r) => setImmediate(r));
    expect(fetchCount).toBe(1);  // single-flight: only one mint fired
    resolveResponse!();
    const results = await Promise.all(promises);
    // Every caller resolved to the same JWT
    expect(new Set(results)).toEqual(new Set(["jwt.1"]));
    expect(fetchCount).toBe(1);
  });

  it("a subsequent call after mint failure re-fires (does not cache the failure)", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ access_token: "jwt.recovered", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const p = new OAuthClientCredentialsProvider("id", "secret", "https://token.example");
    await expect(p.accessToken()).rejects.toThrow(/OAuth token mint failed/);
    await expect(p.accessToken()).resolves.toBe("jwt.recovered");
    expect(fetchCount).toBe(2);
  });
});
