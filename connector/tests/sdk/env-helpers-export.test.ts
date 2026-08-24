import { describe, it, expect } from "vitest";
import { envString, envOptional, envNumber } from "../../src/sdk/index.js";

// MCP-AUDIT #21 — the SDK barrel must re-export the empty-string-safe env
// readers, because `@mcp-shim/connector/sdk` is the ONLY module specifier a
// drop-in MCP can import from. Without the re-export an author's sole option is
// `process.env.FOO ?? default`, which treats "" as set: a blank line in a
// dir/.env, or a controller-supplied key cleared to "", then flows an empty
// string into a URL / port / log level instead of falling back.
//
// The behaviour itself is covered by tests/env.test.ts; what is asserted here is
// that the re-export exists and is the same implementation, so a future edit to
// sdk/index.ts cannot quietly drop it and leave authors with only `??`.

describe("SDK env helpers (MCP-AUDIT #21)", () => {
  it("re-exports all three readers from the barrel drop-ins import", () => {
    expect(typeof envString).toBe("function");
    expect(typeof envOptional).toBe("function");
    expect(typeof envNumber).toBe("function");
  });

  it("treats an empty string as not-set, unlike `??`", () => {
    const env = { BLANK: "" } as NodeJS.ProcessEnv;

    // The footgun this exists to close: `??` would yield "" for all three.
    expect(envString("BLANK", "fallback", env)).toBe("fallback");
    expect(envOptional("BLANK", env)).toBeUndefined();
    expect(envNumber("BLANK", 7400, env)).toBe(7400);
  });

  it("still honours a real value", () => {
    const env = { SET: "http://example.test" } as NodeJS.ProcessEnv;
    expect(envString("SET", "fallback", env)).toBe("http://example.test");
    expect(envOptional("SET", env)).toBe("http://example.test");
    expect(envNumber("PORT", 1, { PORT: "7400" } as NodeJS.ProcessEnv)).toBe(7400);
  });

  it("re-exports the same function identity as src/env.ts", async () => {
    const direct = await import("../../src/env.js");
    expect(envString).toBe(direct.envString);
    expect(envOptional).toBe(direct.envOptional);
    expect(envNumber).toBe(direct.envNumber);
  });
});
