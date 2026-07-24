import { describe, it, expect, vi } from "vitest";
import { envString, envOptional, envNumber } from "../src/env.js";

// env.ts is the centralized env-var reader. Single rule: empty-string == unset.
// All three readers accept an injected env map; the default-arg branch
// (process.env) is exercised once per reader via vi.stubEnv to confirm the
// fallback path. The injected-arg shape is preferred for the rest because
// it's clearer and doesn't touch global state.

describe("envString", () => {
  it("returns the env value when set to a non-empty string", () => {
    expect(envString("FOO", "default", { FOO: "value" } as NodeJS.ProcessEnv)).toBe("value");
  });

  it("returns the default when the env value is undefined", () => {
    expect(envString("FOO", "default", {} as NodeJS.ProcessEnv)).toBe("default");
  });

  it("returns the default when the env value is an empty string (admin's blank-line .env)", () => {
    // The whole point of this module: an empty-string env var must NOT
    // override the documented default. Pin the rule explicitly here.
    expect(envString("FOO", "default", { FOO: "" } as NodeJS.ProcessEnv)).toBe("default");
  });

  it("preserves whitespace-only values verbatim (does NOT trim — that's the caller's concern)", () => {
    // Only an actual empty string is treated as unset. " " or "\t" is set.
    expect(envString("FOO", "default", { FOO: "   " } as NodeJS.ProcessEnv)).toBe("   ");
  });

  it("default-arg branch reads from process.env when no env map is passed", () => {
    vi.stubEnv("ENVTEST_STR", "from-process-env");

    expect(envString("ENVTEST_STR", "fallback")).toBe("from-process-env");
  });
});

describe("envOptional", () => {
  it("returns the env value when set to a non-empty string", () => {
    expect(envOptional("FOO", { FOO: "value" } as NodeJS.ProcessEnv)).toBe("value");
  });

  it("returns undefined when the env value is undefined", () => {
    expect(envOptional("FOO", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("returns undefined when the env value is empty string", () => {
    expect(envOptional("FOO", { FOO: "" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("default-arg branch reads from process.env", () => {
    vi.stubEnv("ENVTEST_OPT", "");
    expect(envOptional("ENVTEST_OPT")).toBeUndefined();
  });
});

describe("envNumber", () => {
  it("returns the parsed number when the env value is a valid integer", () => {
    expect(envNumber("PORT", 9090, { PORT: "7100" } as NodeJS.ProcessEnv)).toBe(7100);
  });

  it("returns the parsed number when the env value is a valid float", () => {
    expect(envNumber("FACTOR", 1, { FACTOR: "1.5" } as NodeJS.ProcessEnv)).toBe(1.5);
  });

  it("returns the default when undefined", () => {
    expect(envNumber("PORT", 9090, {} as NodeJS.ProcessEnv)).toBe(9090);
  });

  it("returns the default when empty string", () => {
    expect(envNumber("PORT", 9090, { PORT: "" } as NodeJS.ProcessEnv)).toBe(9090);
  });

  it("throws an admin-actionable error when the env value is non-numeric", () => {
    // The pre-refactor `Number(process.env.X ?? 9090)` silently coerced "foo"
    // to NaN, which then flowed into setInterval / port-binding / pino-level
    // and produced an obscure failure 5 layers downstream. Fail loudly here
    // with a message that names the var, the bad value, AND the recovery.
    expect(() => envNumber("PORT", 9090, { PORT: "not-a-number" } as NodeJS.ProcessEnv))
      .toThrow(/PORT must be a number; got "not-a-number"/);
    expect(() => envNumber("PORT", 9090, { PORT: "not-a-number" } as NodeJS.ProcessEnv))
      .toThrow(/unset it to use the default \(9090\)/);
  });

  it("throws on Infinity / -Infinity (Number.isFinite gate)", () => {
    expect(() => envNumber("PORT", 9090, { PORT: "Infinity" } as NodeJS.ProcessEnv))
      .toThrow(/PORT must be a number/);
  });

  it("default-arg branch reads from process.env", () => {
    vi.stubEnv("ENVTEST_NUM", "42");
    expect(envNumber("ENVTEST_NUM", 1)).toBe(42);
  });
});
