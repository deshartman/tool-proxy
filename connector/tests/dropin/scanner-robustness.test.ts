import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverDropins } from "@connector/dropin.js";

// MCP-AUDIT #7 + #31 — both live in scanFolder's per-entry loop, so they are
// fixed and tested together.
//
// #7: statSync follows symlinks and THROWS on a dangling one. The call was
// unguarded and neither call site wraps discoverDropins — boot/lifecycle.ts calls
// it bare, and so does local-mcps-coordinator's rescan. So ONE broken symlink
// meant ZERO MCPs discovered, presenting as a boot crash rather than "your
// drop-ins are missing". That is not hypothetical for this repo: the dev workflow
// symlinks customer-mcps/<name> to ABSOLUTE paths under examples/demos/, so
// moving or renaming the checkout breaks all of them at once.
//
// #31: discovery followed a symlink straight out of MCP_DROPIN_DIR. The threat is
// a privilege split, not an attacker who can already write to the drop-in dir
// (they would just drop a .ts file): a read-only mount is treated as reviewed,
// but a symlink committed into it points at a writable path, so the reviewed
// artifact runs unreviewed code with no diff showing it.

let root: string;
let outside: string;
const SAVED = process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE;

function makeDropin(dir: string, name: string): string {
  const folder = join(dir, name);
  mkdirSync(join(folder, "tools"), { recursive: true });
  writeFileSync(join(folder, "tools", "noop.ts"), "export default { name: 'noop', register() {} };\n");
  return folder;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dropin-root-"));
  outside = mkdtempSync(join(tmpdir(), "dropin-outside-"));
  delete process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  if (SAVED === undefined) delete process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE;
  else process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE = SAVED;
});

const names = (specs: Array<{ name: string }>): string[] => specs.map((s) => s.name).sort();

describe("MCP-AUDIT #7 — one bad entry must not take down the whole scan", () => {
  it("skips a dangling symlink and still discovers the healthy siblings", () => {
    makeDropin(root, "healthy-a");
    makeDropin(root, "healthy-b");
    symlinkSync(join(outside, "does-not-exist"), join(root, "broken"));

    // Before the fix this threw ENOENT out of statSync and returned nothing.
    const specs = discoverDropins({ yamlNames: new Set(), dropinDir: root });
    expect(names(specs)).toEqual(["healthy-a", "healthy-b"]);
  });

  it("survives a symlink whose target vanished after it was created", () => {
    makeDropin(root, "healthy");
    const target = makeDropin(outside, "temporarily-there");
    symlinkSync(target, join(root, "vanishing"));
    rmSync(target, { recursive: true, force: true });   // now dangling

    expect(() => discoverDropins({ yamlNames: new Set(), dropinDir: root })).not.toThrow();
    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root }))).toEqual(["healthy"]);
  });

  it("returns [] rather than throwing when the drop-in dir itself is a dangling symlink", () => {
    const badRoot = join(outside, "nowhere-link");
    symlinkSync(join(outside, "nothing-here"), badRoot);
    expect(() => discoverDropins({ yamlNames: new Set(), dropinDir: badRoot })).not.toThrow();
    expect(discoverDropins({ yamlNames: new Set(), dropinDir: badRoot })).toEqual([]);
  });
});

describe("MCP-AUDIT #31 — discovery stays inside MCP_DROPIN_DIR", () => {
  it("refuses a folder that resolves outside the root, by default", () => {
    makeDropin(root, "legit");
    const escaped = makeDropin(outside, "escaped");
    symlinkSync(escaped, join(root, "escaped"));

    const specs = discoverDropins({ yamlNames: new Set(), dropinDir: root });
    expect(names(specs)).toEqual(["legit"]);        // "escaped" rejected
  });

  it("allows the escape when the dev opt-out is set", () => {
    // scripts/start-connector.sh sets this — the documented dev workflow
    // symlinks examples/demos/<name> into customer-mcps/<name>.
    process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE = "1";
    makeDropin(root, "legit");
    const escaped = makeDropin(outside, "escaped");
    symlinkSync(escaped, join(root, "escaped"));

    const specs = discoverDropins({ yamlNames: new Set(), dropinDir: root });
    expect(names(specs)).toEqual(["escaped", "legit"]);
  });

  it("only `1` opts out — any other value still enforces", () => {
    for (const v of ["0", "true", "yes", ""]) {
      process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE = v;
      const r = mkdtempSync(join(tmpdir(), "dropin-strict-"));
      try {
        makeDropin(r, "legit");
        symlinkSync(makeDropin(outside, `esc-${v || "empty"}`), join(r, "escaped"));
        expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: r })), `value ${JSON.stringify(v)}`).toEqual(["legit"]);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    }
  });

  it("a symlinked ROOT is fine — that is the operator's own choice of location", () => {
    // Only per-entry escapes are refused; pointing MCP_DROPIN_DIR itself at a
    // symlink is normal (a volume mount often is one).
    makeDropin(root, "inside");
    const rootLink = join(outside, "root-link");
    symlinkSync(root, rootLink);

    const specs = discoverDropins({ yamlNames: new Set(), dropinDir: rootLink });
    expect(names(specs)).toEqual(["inside"]);
  });

  it("an internal symlink pointing within the root is allowed", () => {
    const real = makeDropin(root, "real");
    symlinkSync(real, join(root, "alias"));
    // Both resolve inside the root, so both are discovered (distinct names).
    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root }))).toEqual(["alias", "real"]);
  });
});

describe("MCP-AUDIT #7/#31 — the existing contract still holds", () => {
  it("still skips folders with no tools/ and folders with a hand-written server.ts", () => {
    makeDropin(root, "good");
    mkdirSync(join(root, "no-tools"), { recursive: true });
    const handwritten = makeDropin(root, "handwritten");
    writeFileSync(join(handwritten, "server.ts"), "// hand-written Type 1\n");

    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root }))).toEqual(["good"]);
  });

  it("still lets a yaml entry win by name", () => {
    makeDropin(root, "shadowed");
    makeDropin(root, "kept");
    expect(names(discoverDropins({ yamlNames: new Set(["shadowed"]), dropinDir: root }))).toEqual(["kept"]);
  });
});

describe("MCP-AUDIT #16 — folder name must be a routable MCP name", () => {
  it("skips a name containing a dot, which would break dispatcher routing", () => {
    // The dispatcher splits `${server}.${tool}` on the FIRST dot, so a folder
    // named `acme.crm` yields `acme.crm.get_customer` -> server `acme`, tool
    // `crm.get_customer` -> tool_not_found for every tool, unexplained.
    makeDropin(root, "good-name");
    makeDropin(root, "acme.crm");
    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root }))).toEqual(["good-name"]);
  });

  it("skips names with whitespace or leading punctuation", () => {
    makeDropin(root, "keeper");
    makeDropin(root, "has space");
    makeDropin(root, "-leading-dash");
    makeDropin(root, "_leading-underscore");
    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root }))).toEqual(["keeper"]);
  });

  it("accepts every name we actually ship", () => {
    for (const n of ["agentic-memory", "crm", "salesforce", "sample", "my_mcp", "mcp2"]) {
      makeDropin(root, n);
    }
    expect(names(discoverDropins({ yamlNames: new Set(), dropinDir: root })))
      .toEqual(["agentic-memory", "crm", "mcp2", "my_mcp", "salesforce", "sample"]);
  });
});
