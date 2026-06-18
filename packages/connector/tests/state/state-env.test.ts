import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { defaultStatePath, readState, writeState, clearRegistrationToken } from "../../src/state.js";

// state.ts reads CONNECTOR_STATE_PATH from process.env directly via the
// defaultStatePath() helper. Tests below pin:
//   * the unset → resolved-default path,
//   * relative override resolves against cwd,
//   * absolute override is used as-is,
//   * round-trip read-after-write across all three.
//
// Use vi.stubEnv per TEST-SUITE.md guidance. Avoid setting process.env
// directly, avoid loading any .env file.

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "connector-state-test-"));
  tmpRoots.push(dir);
  return dir;
}

describe("defaultStatePath() — CONNECTOR_STATE_PATH dispatch", () => {
  it("returns the documented default path resolved to absolute when CONNECTOR_STATE_PATH is unset", () => {
    // Pass `undefined` to vi.stubEnv to truly delete the var (vitest 4 API)
    // — distinct from passing "" which leaves the key on process.env with
    // an empty value and short-circuits the `??` check below.
    vi.stubEnv("CONNECTOR_STATE_PATH", undefined);

    const path = defaultStatePath();

    // Default is "packages/connector/.connector-state.json" — resolved
    // against process.cwd() into an absolute path. The exact string depends
    // on where vitest is run from; assert the shape rather than the
    // literal.
    expect(isAbsolute(path)).toBe(true);
    expect(path).toContain(`packages${sep}connector${sep}.connector-state.json`);
  });

  it("an empty-string CONNECTOR_STATE_PATH falls back to the default (treats blank-line .env as 'unset')", () => {
    // The connector-wide rule (env.ts): empty-string env var == not set.
    // An admin who writes `CONNECTOR_STATE_PATH=` in .env gets the
    // documented default, not a silent state-file relocation to cwd.
    // Pre-fix this case asserted the broken behavior (resolve("") == cwd);
    // post-fix it affirms the corrected behavior.
    vi.stubEnv("CONNECTOR_STATE_PATH", "");

    const path = defaultStatePath();

    expect(isAbsolute(path)).toBe(true);
    expect(path).toContain(`packages${sep}connector${sep}.connector-state.json`);
  });

  it("an absolute CONNECTOR_STATE_PATH is used verbatim", () => {
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    expect(defaultStatePath()).toBe(target);
  });

  it("a relative CONNECTOR_STATE_PATH is resolved against the current working directory", () => {
    vi.stubEnv("CONNECTOR_STATE_PATH", "relative/state.json");

    const path = defaultStatePath();

    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(resolve("relative/state.json"));
  });
});

describe("read/write/clear with CONNECTOR_STATE_PATH set", () => {
  it("readState() at the env-driven path returns {} when the file does not yet exist", () => {
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    const state = readState();

    expect(state).toEqual({});
  });

  it("writeState({registrationToken}) at the env-driven path is round-trippable via readState()", () => {
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    writeState({ registrationToken: "mint-1" });

    expect(readState()).toEqual({ registrationToken: "mint-1" });
    // Atomic-rename invariant: the .tmp sibling must NOT survive a write.
    expect(existsSync(target + ".tmp")).toBe(false);
  });

  it("clearRegistrationToken() at the env-driven path removes the file (used for unknown_registration_token self-heal)", () => {
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    writeState({ registrationToken: "stale" });
    expect(existsSync(target)).toBe(true);

    clearRegistrationToken();

    expect(existsSync(target)).toBe(false);
    // Subsequent readState must observe the clean-slate shape so the next
    // boot's first-connect path mints a fresh token.
    expect(readState()).toEqual({});
  });

  it("readState() throws an admin-actionable error naming the path when the file is corrupt JSON", () => {
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    writeFileSync(target, "{not-valid-json", "utf8");

    // Error must include the path so the operator knows which file to
    // inspect / delete (the recovery is `rm .connector-state.json`).
    expect(() => readState()).toThrow(new RegExp(target));
  });

  it("a writeState/readState round-trip ignores unknown keys (forward compat with future state fields)", () => {
    // The schema today only knows registrationToken. A future connector
    // version writing an extra field should not break this version's
    // read path. Pin the parser's "ignore unknown" behavior so a later
    // refactor to a strict schema is a deliberate decision.
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    writeFileSync(
      target,
      JSON.stringify({ registrationToken: "abc", futureField: "from-tomorrow" }),
      "utf8",
    );

    const state = readState();

    expect(state.registrationToken).toBe("abc");
    expect(state).not.toHaveProperty("futureField");
  });

  it("a non-string registrationToken on disk is treated as missing (defensive read against hand-edited file)", () => {
    // An admin who hand-edits .connector-state.json and accidentally writes
    // {"registrationToken": null} or {"registrationToken": 42} should get a
    // clean first-connect, not a crash with `unknown_registration_token`.
    const root = makeTempRoot();
    const target = join(root, ".connector-state.json");
    vi.stubEnv("CONNECTOR_STATE_PATH", target);

    writeFileSync(target, JSON.stringify({ registrationToken: 42 }), "utf8");

    expect(readState()).toEqual({ registrationToken: undefined });
  });
});

describe("env isolation across tests", () => {
  it("a CONNECTOR_STATE_PATH stubbed in a previous case does NOT leak into this one (vi auto-rolls back)", () => {
    // Sibling case stubbed CONNECTOR_STATE_PATH=/tmp/.../*.json. With
    // unstubEnvs:true in vitest.config.ts, the next case starts clean. If
    // the rollback ever regresses, defaultStatePath() will return that
    // tmpdir path here and break the assertion. This is the test that
    // catches a config drift, not a behavior change.
    const path = defaultStatePath();
    expect(path).not.toMatch(/connector-state-test-/);
  });
});
