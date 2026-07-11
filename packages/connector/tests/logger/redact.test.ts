import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createLogger } from "@connector/logger.js";

// INSPECTOR-CREDS-VISIBILITY (W-S6) — runtime redact backstop. The
// production discipline is "don't log values" (key-names only). This
// suite pins the belt-and-braces redact: if a future log call DID leak
// a value through one of the known sensitive paths, Pino's redact
// censors it before it hits stdout. Pair with the W-S9 leak test pack
// which exercises end-to-end paste cycles.

describe("logger redact (W-S6)", () => {
  const captured: string[] = [];
  let restore: (() => void) | undefined;

  beforeEach(() => {
    captured.length = 0;
    const orig = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return (orig as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    restore = () => {
      process.stdout.write = orig;
    };
  });
  afterEach(() => {
    restore?.();
  });

  it("redacts top-level env, controllerEnv, sessionEnv", () => {
    const log = createLogger("redact-test");
    log.info({
      env: { TWILIO_AUTH_TOKEN: "tok_secret_1" },
      controllerEnv: { CONTROLLER_API_TOKEN: "tok_secret_2" },
      sessionEnv: { SESSION_API_TOKEN: "tok_secret_3" },
    }, "merge env");
    const blob = captured.join("");
    expect(blob).not.toContain("tok_secret_1");
    expect(blob).not.toContain("tok_secret_2");
    expect(blob).not.toContain("tok_secret_3");
    // Sanity: the log line still arrived.
    expect(blob).toContain("merge env");
  });

  it("redacts headers.authorization", () => {
    const log = createLogger("redact-test");
    log.info({
      spec: { headers: { authorization: "Bearer tok_secret_jwt" } },
    }, "auth headers");
    const blob = captured.join("");
    expect(blob).not.toContain("tok_secret_jwt");
  });

  it("redacts common cred-shaped field names (token, secret, apiKey, authToken)", () => {
    const log = createLogger("redact-test");
    log.info({
      token: "tok_secret_a",
      secret: "tok_secret_b",
      apiKey: "tok_secret_c",
      authToken: "tok_secret_d",
    }, "cred-shaped fields");
    const blob = captured.join("");
    expect(blob).not.toContain("tok_secret_a");
    expect(blob).not.toContain("tok_secret_b");
    expect(blob).not.toContain("tok_secret_c");
    expect(blob).not.toContain("tok_secret_d");
  });

  it("does NOT redact non-sensitive fields (regression — overzealous redact would mask real signals)", () => {
    const log = createLogger("redact-test");
    log.info({ name: "my-mcp", port: 7100, source: "yaml" }, "spawn complete");
    const blob = captured.join("");
    expect(blob).toContain("my-mcp");
    expect(blob).toContain("7100");
    expect(blob).toContain("yaml");
  });

  // Step 11 additions — tunnel-cred field names carried on the decrypted
  // ControllerRow. `authToken` was already redacted; these three sit on
  // the row under distinct exact keys and each needs its own path entry.
  it("redacts tunnel-cred field names (tunnelAuthToken, oauthClientSecret, registrationToken)", () => {
    const log = createLogger("redact-test");
    log.info({
      row: {
        tunnelAuthToken: "tok_tunnel_secret",
        oauthClientSecret: "tok_oauth_secret",
        registrationToken: "tok_reg_secret",
      },
    }, "controller row loaded");
    const blob = captured.join("");
    expect(blob).not.toContain("tok_tunnel_secret");
    expect(blob).not.toContain("tok_oauth_secret");
    expect(blob).not.toContain("tok_reg_secret");
    // Sanity: the log line still arrived.
    expect(blob).toContain("controller row loaded");
  });

  it("redacts encrypted-column names when raw pg rows are logged", () => {
    const log = createLogger("redact-test");
    // Simulate an accidental `log.info({rows}, ...)` after a raw pg query.
    // The BYTEA columns come through as Buffers; serialized as objects. If
    // someone ever logs the raw row we want the ct bytes redacted too.
    log.info({
      row: {
        tunnel_auth_token_ct: "raw_bytea_bytes_tunnel",
        oauth_client_secret_ct: "raw_bytea_bytes_oauth",
        registration_token_ct: "raw_bytea_bytes_reg",
      },
    }, "raw pg row");
    const blob = captured.join("");
    expect(blob).not.toContain("raw_bytea_bytes_tunnel");
    expect(blob).not.toContain("raw_bytea_bytes_oauth");
    expect(blob).not.toContain("raw_bytea_bytes_reg");
  });

  it("redacts master-key bytes when resolveMasterKey struct is logged", () => {
    const log = createLogger("redact-test");
    log.info({
      masterKey: { bytes: "raw_32_master_key_bytes", fingerprint: "sha256:abc123" },
    }, "master key resolved");
    const blob = captured.join("");
    expect(blob).not.toContain("raw_32_master_key_bytes");
    // Fingerprint is not secret — sha256 of the key is already leakable via
    // encryption_meta and gets logged intentionally on the mismatch error.
    expect(blob).toContain("sha256:abc123");
  });
});
