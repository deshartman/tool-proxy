import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// MCP-AUDIT #11 + #12 — two DSN string-munging bugs in neighbouring shell files,
// both with a character-class blind spot. Fixed and tested together.
//
// #11 (scripts/start-connector.sh): the password mask used `[^/]*`, which cannot
// cross a `/`. A password containing one made the pattern fail to match, so the
// WHOLE DSN printed unmasked — measured, not theorised.
//
// #12 (connector/entrypoint.sh): the DSN was assembled with
// `sed "s|__PWFILE__|$pw|"`. `&` is the replacement-side metacharacter meaning
// "the whole match", so `a&b` expanded to `a__PWFILE__b`; a `|` in the password
// terminated the expression outright. Both surfaced as a bare authentication
// failure with no hint at the cause, and the password sat in sed's argv where `ps`
// could read it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");

const sh = (script: string): string =>
  execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim();

describe("MCP-AUDIT #11 — the DSN mask covers every password shape", () => {
  // The exact expression from start-connector.sh, so drift fails here.
  const MASK = String.raw`sed -E 's#://([^:/@]+):.*@#://\1:***@#'`;

  const mask = (pw: string): string =>
    sh(`printf '%s' 'postgres://mcp:${pw}@localhost:5432/db' | ${MASK}`);

  it("masks a password containing a slash — the case that leaked", () => {
    expect(mask("has/slash")).toBe("postgres://mcp:***@localhost:5432/db");
  });

  it("masks passwords containing :, @, &, and |", () => {
    for (const pw of ["has:colon", "p@ss", "a&b", "a|b"]) {
      expect(mask(pw), `password ${pw}`).toBe("postgres://mcp:***@localhost:5432/db");
    }
  });

  it("leaves a passwordless DSN untouched", () => {
    expect(sh(`printf '%s' 'postgres://localhost:5432/db' | ${MASK}`))
      .toBe("postgres://localhost:5432/db");
  });

  it("never emits the password, for any shape", () => {
    for (const pw of ["simple", "has/slash", "has:colon", "p@ss", "a&b", "a|b"]) {
      expect(mask(pw)).not.toContain(pw);
    }
  });

  it("start-connector.sh uses the greedy form, not the [^/]* form", () => {
    const src = readFileSync(join(ROOT, "scripts/start-connector.sh"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toContain(String.raw`s#://([^:/@]+):.*@#://\1:***@#`);
    expect(code).not.toContain(String.raw`s#://([^:/@]+):[^/]*@#`);
  });
});

describe("MCP-AUDIT #12 — the DSN is assembled without sed", () => {
  // The exact expansion from entrypoint.sh.
  const build = (pw: string): string =>
    sh(`T='postgres://mcp:__PWFILE__@db:5432/mcp_connector'; pw='${pw}'; ` +
       `prefix=\${T%%__PWFILE__*}; suffix=\${T#*__PWFILE__}; printf '%s' "\${prefix}\${pw}\${suffix}"`);

  it("inserts an ampersand password literally (sed expanded it to the match)", () => {
    expect(build("a&b")).toBe("postgres://mcp:a&b@db:5432/mcp_connector");
  });

  it("inserts a pipe password literally (sed failed outright)", () => {
    expect(build("a|b")).toBe("postgres://mcp:a|b@db:5432/mcp_connector");
  });

  it("handles slashes, colons and at-signs", () => {
    expect(build("p/w")).toBe("postgres://mcp:p/w@db:5432/mcp_connector");
    expect(build("p:w")).toBe("postgres://mcp:p:w@db:5432/mcp_connector");
    expect(build("p@w")).toBe("postgres://mcp:p@w@db:5432/mcp_connector");
  });

  it("entrypoint.sh no longer shells out to sed for the DSN, and unsets the temps", () => {
    const src = readFileSync(join(ROOT, "connector/entrypoint.sh"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/sed\s+"s\|__PWFILE__/);
    expect(code).toContain("prefix=${POSTGRES_URL_TEMPLATE%%__PWFILE__*}");
    expect(code).toContain("suffix=${POSTGRES_URL_TEMPLATE#*__PWFILE__}");
    // The password and both temps must not survive into the child's env.
    expect(code).toMatch(/unset pw prefix suffix POSTGRES_URL_TEMPLATE POSTGRES_PW_FILE/);
  });

  it("entrypoint.sh is still valid POSIX sh", () => {
    expect(() => execFileSync("sh", ["-n", join(ROOT, "connector/entrypoint.sh")])).not.toThrow();
  });
});
