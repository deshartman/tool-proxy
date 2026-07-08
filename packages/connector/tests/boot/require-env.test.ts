import { describe, it, expect } from "vitest";

import { requireEnv } from "../../src/boot/require-env.js";

// requireEnv() is the boot preflight. Each missing-key class is one test;
// "all missing keys reported in one pass" is the whole point — boot must not
// fail-fix-reboot across three scattered errors.
//
// All cases inject a literal env map. No vi.stubEnv needed; requireEnv
// accepts an env arg specifically so this is a pure-function exercise.

const ALL_REQUIRED: NodeJS.ProcessEnv = {
  CONNECTOR_CONFIG: "/path/to/connector.yaml",
  CONTROLLER_URL: "https://controller.example.com",
  CONNECTOR_NAME: "test-customer",
  TUNNEL_AUTH_TOKEN: "ts_test_token",
};

describe("requireEnv — happy paths", () => {
  it("returns cleanly when all required vars are present (static-bearer posture)", () => {
    expect(() => requireEnv(ALL_REQUIRED)).not.toThrow();
  });

  it("returns cleanly when all required vars are present (OAuth2 posture)", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "/path/to/connector.yaml",
      CONTROLLER_URL: "https://controller.example.com",
      CONNECTOR_NAME: "test-customer",
      OAUTH_CLIENT_ID: "client_test",
      OAUTH_CLIENT_SECRET: "secret_test",
      OAUTH_TOKEN_URL: "https://oauth.example.com/token",
    };

    expect(() => requireEnv(env)).not.toThrow();
  });
});

describe("requireEnv — individual missing keys", () => {
  it("throws naming CONTROLLER_URL when missing", () => {
    const env = { ...ALL_REQUIRED };
    delete env.CONTROLLER_URL;

    expect(() => requireEnv(env)).toThrow(/CONTROLLER_URL is required/);
  });

  it("throws naming CONNECTOR_NAME when missing, with the case-sensitivity hint", () => {
    const env = { ...ALL_REQUIRED };
    delete env.CONNECTOR_NAME;

    expect(() => requireEnv(env)).toThrow(/CONNECTOR_NAME is required/);
    // Case-sensitivity is a load-bearing detail per CLAUDE.md (the
    // controller looks up the row by name); admins miss this often
    // enough that the error message names it.
    expect(() => requireEnv(env)).toThrow(/case-sensitive/);
  });
});

describe("requireEnv — CONNECTOR_CONFIG default", () => {
  // The customer runs `npx mcp-connector start` from their project directory
  // where `.env` and `connector.yaml` live at the top level. requireEnv fills
  // in the ./connector.yaml default so they don't need to remember to pass
  // --config on every invocation.

  it("sets CONNECTOR_CONFIG to ./connector.yaml when unset", () => {
    const env = { ...ALL_REQUIRED };
    delete env.CONNECTOR_CONFIG;

    requireEnv(env);

    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("sets CONNECTOR_CONFIG to ./connector.yaml when empty-string (blank-line .env)", () => {
    // Empty-string == unset per envOptional's connector-wide semantics.
    const env = { ...ALL_REQUIRED, CONNECTOR_CONFIG: "" };

    requireEnv(env);

    expect(env.CONNECTOR_CONFIG).toBe("./connector.yaml");
  });

  it("leaves an explicit CONNECTOR_CONFIG value untouched", () => {
    const env = { ...ALL_REQUIRED, CONNECTOR_CONFIG: "/custom/path/config.yaml" };

    requireEnv(env);

    expect(env.CONNECTOR_CONFIG).toBe("/custom/path/config.yaml");
  });
});

describe("requireEnv — auth posture", () => {
  it("reports both posture options when neither TUNNEL_AUTH_TOKEN nor OAUTH_CLIENT_ID is set", () => {
    const env = { ...ALL_REQUIRED };
    delete env.TUNNEL_AUTH_TOKEN;

    expect(() => requireEnv(env)).toThrow(/Auth posture missing/);
    expect(() => requireEnv(env)).toThrow(/TUNNEL_AUTH_TOKEN/);
    expect(() => requireEnv(env)).toThrow(/OAUTH_CLIENT_ID/);
  });

  it("reports OAuth2 posture incomplete (CLIENT_SECRET missing) when CLIENT_ID is set", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "/path/to/connector.yaml",
      CONTROLLER_URL: "https://controller.example.com",
      CONNECTOR_NAME: "test-customer",
      OAUTH_CLIENT_ID: "client_test",
      OAUTH_TOKEN_URL: "https://oauth.example.com/token",
    };

    // Posture-aware error: tells the admin "you started OAuth2, here's
    // what's missing" rather than three separate "X is required" lines.
    expect(() => requireEnv(env)).toThrow(/Auth posture incomplete/);
    expect(() => requireEnv(env)).toThrow(/OAUTH_CLIENT_ID is set/);
    expect(() => requireEnv(env)).toThrow(/OAUTH_CLIENT_SECRET/);
  });

  it("reports OAuth2 posture incomplete (TOKEN_URL missing) when CLIENT_ID is set", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "/path/to/connector.yaml",
      CONTROLLER_URL: "https://controller.example.com",
      CONNECTOR_NAME: "test-customer",
      OAUTH_CLIENT_ID: "client_test",
      OAUTH_CLIENT_SECRET: "secret_test",
    };

    expect(() => requireEnv(env)).toThrow(/Auth posture incomplete/);
    expect(() => requireEnv(env)).toThrow(/OAUTH_TOKEN_URL/);
  });

  it("reports BOTH OAuth2 vars missing in one error (CLIENT_SECRET and TOKEN_URL) when CLIENT_ID alone is set", () => {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_CONFIG: "/path/to/connector.yaml",
      CONTROLLER_URL: "https://controller.example.com",
      CONNECTOR_NAME: "test-customer",
      OAUTH_CLIENT_ID: "client_test",
    };

    // Both joined into one finding, not two. Admin sees the full picture.
    const error = captureError(() => requireEnv(env));
    expect(error.message).toMatch(/OAUTH_CLIENT_SECRET and OAUTH_TOKEN_URL are also required/);
  });

  it("an empty-string OAUTH_CLIENT_ID is treated as 'OAuth2 not started' (matches env.ts truthy semantics)", () => {
    const env = { ...ALL_REQUIRED, OAUTH_CLIENT_ID: "" };

    // Static-bearer is set so the preflight passes — the empty OAUTH_CLIENT_ID
    // does NOT flip into OAuth2 posture and demand its siblings.
    expect(() => requireEnv(env)).not.toThrow();
  });
});

describe("requireEnv — multiple missing keys reported together", () => {
  it("lists every missing required var in one consolidated error", () => {
    const env: NodeJS.ProcessEnv = {};

    const error = captureError(() => requireEnv(env));

    // Single throw, every problem visible. This is the whole point of
    // having a preflight — admin fixes one .env, not three.
    // CONNECTOR_CONFIG isn't listed because it defaults to ./connector.yaml;
    // if the file doesn't exist, loadConfig throws a separate error naming
    // the resolved path — that's more actionable than a "missing" message
    // in the preflight.
    expect(error.message).toContain("CONTROLLER_URL");
    expect(error.message).toContain("CONNECTOR_NAME");
    expect(error.message).toContain("Auth posture missing");
  });

  it("the consolidated error opens with a header naming the failure mode", () => {
    const env: NodeJS.ProcessEnv = {};

    const error = captureError(() => requireEnv(env));

    expect(error.message).toMatch(/^Connector boot failed: env config incomplete/);
  });

  it("the consolidated error closes by pointing at .env.example and 'mcp-connector init'", () => {
    const env: NodeJS.ProcessEnv = {};

    const error = captureError(() => requireEnv(env));

    // Customer-facing hint: name the shipped template, and offer the init
    // subcommand as the "I don't have a template on disk" shortcut.
    expect(error.message).toMatch(/\.env\.example/);
    expect(error.message).toMatch(/mcp-connector init/);
  });
});

// Helper: run a thrower and return the Error so tests can match against the
// full message. expect(...).toThrow only checks one regex per call, which
// makes "all four findings present" assertions awkward.
function captureError(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected fn to throw, but it didn't");
}
