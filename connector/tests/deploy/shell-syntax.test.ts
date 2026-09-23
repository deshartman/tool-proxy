import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

// Every tracked shell script must PARSE. Trivial, and it would have caught a
// real break: a regex that stripped a retired `--controller-url` flag from docs
// and scripts ate a closing double-quote in scripts/deploy/fly-deploy.sh —
//
//   echo "[fly-deploy]     --name <CUSTOMER-NAME> >&2
//
// The string never terminates, so bash consumes the following lines and reports
// a syntax error 35 lines later, nowhere near the damage. The script was the
// production Fly deploy path and had been broken for two commits with nothing
// noticing, because nothing in the suite executed or parsed it.
//
// `bash -n` is parse-only: it never runs a command, so this is safe for scripts
// that would otherwise create resources.

const REPO_ROOT = resolvePath(new URL("../../../", import.meta.url).pathname);

/** Tracked .sh files, excluding anything under ignored build output. */
function shellScripts(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".terraform") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) shellScripts(full, acc);
    else if (entry.endsWith(".sh")) acc.push(full);
  }
  return acc;
}

const scripts = shellScripts(REPO_ROOT);

describe("shell scripts parse", () => {
  it("finds scripts to check (guards against a vacuous pass)", () => {
    // An empty list would make every assertion below trivially true.
    expect(scripts.length).toBeGreaterThan(3);
    expect(scripts.some((s) => s.endsWith("fly-deploy.sh"))).toBe(true);
  });

  it.each(scripts.map((s) => s.slice(REPO_ROOT.length)))("%s parses", (rel) => {
    // Parse only — bash -n executes nothing.
    expect(() =>
      execFileSync("bash", ["-n", join(REPO_ROOT, rel)], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
