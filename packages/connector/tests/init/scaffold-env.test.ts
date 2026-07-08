import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { scaffoldEnv, findShippedEnvExample } from "../../src/init.js";

// `mcp-connector init` scaffolds `.env` alongside `connector.yaml` by copying
// the shipped `.env.example` from inside the installed package. Two invariants
// pinned here:
//   1. Never overwrite an existing `.env` — the customer's edits are load-
//      bearing, and a re-run of `init` after tweaking creds would silently
//      restore them to placeholders otherwise.
//   2. Resolve `.env.example` relative to init.ts's own module URL, so the
//      same code path works in dev (packages/connector/dist/init.js →
//      ../.env.example) AND post-publish (node_modules/@mcp-shim/connector/
//      dist/init.js → ../.env.example). One resolution path covers both.

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "connector-init-test-"));
  tmpRoots.push(dir);
  return dir;
}

// Build a fake "installed package layout" — a scratch dir shaped like the
// compiled npm tarball: `pkg/dist/init.js` + `pkg/.env.example`. Return the
// file URL of the fake init.js so scaffoldEnv can resolve `../.env.example`
// relative to it.
function makeFakePackageLayout(exampleContents: string | null): {
  moduleUrl: string;
  pkgRoot: string;
} {
  const pkgRoot = makeTempRoot();
  mkdirSync(join(pkgRoot, "dist"), { recursive: true });
  const initPath = join(pkgRoot, "dist", "init.js");
  writeFileSync(initPath, "", "utf8");
  if (exampleContents !== null) {
    writeFileSync(join(pkgRoot, ".env.example"), exampleContents, "utf8");
  }
  return { moduleUrl: pathToFileURL(initPath).href, pkgRoot };
}

describe("findShippedEnvExample", () => {
  it("resolves .env.example at the ship location (one directory above the module file)", () => {
    // The ship location is `<pkg>/.env.example` — sibling of `<pkg>/dist/`.
    // Both post-postbuild dev and post-publish `node_modules/` have this
    // shape, so the resolver checks here first.
    const { moduleUrl, pkgRoot } = makeFakePackageLayout("STUB_CONTENTS=1\n");

    const resolved = findShippedEnvExample(moduleUrl);

    expect(resolved).toBe(join(pkgRoot, ".env.example"));
  });

  it("returns null when .env.example is not at either the ship location or the repo-root fallback", () => {
    // Package where dist/init.js exists but no template is available at
    // either the sibling location or the three-dirs-up repo-root fallback —
    // the scenario where a future `packages/connector/package.json` edit
    // accidentally drops ".env.example" from the `files` allowlist. Init
    // should degrade gracefully rather than throwing an ENOENT the customer
    // has no context to interpret.
    const { moduleUrl } = makeFakePackageLayout(null);

    const resolved = findShippedEnvExample(moduleUrl);

    expect(resolved).toBeNull();
  });
});

describe("scaffoldEnv", () => {
  it("writes .env from the shipped template when the destination doesn't exist", () => {
    const { moduleUrl } = makeFakePackageLayout("CONTROLLER_URL=\nTUNNEL_AUTH_TOKEN=\n");
    const destPath = join(makeTempRoot(), ".env");

    const created = scaffoldEnv(destPath, moduleUrl);

    expect(created).toBe(true);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf8")).toBe("CONTROLLER_URL=\nTUNNEL_AUTH_TOKEN=\n");
  });

  it("does NOT overwrite an existing .env (customer edits are load-bearing)", () => {
    const { moduleUrl } = makeFakePackageLayout("PLACEHOLDER=1\n");
    const destPath = join(makeTempRoot(), ".env");
    // Simulate the customer having already edited .env with real creds.
    writeFileSync(
      destPath,
      "CONTROLLER_URL=https://real.example.com\nTUNNEL_AUTH_TOKEN=ts_real\n",
      "utf8",
    );

    const created = scaffoldEnv(destPath, moduleUrl);

    expect(created).toBe(false);
    // Confirm the placeholder template never touched the customer's file.
    expect(readFileSync(destPath, "utf8")).toBe(
      "CONTROLLER_URL=https://real.example.com\nTUNNEL_AUTH_TOKEN=ts_real\n",
    );
  });

  it("returns false + warns (not throws) when .env.example is missing from the package", () => {
    // Same graceful-degrade scenario as findShippedEnvExample's null case,
    // but assert scaffoldEnv's behavior: it must NOT throw (init flow
    // continues; the yaml still gets written), and it must warn so the
    // developer notices the missing template.
    const { moduleUrl } = makeFakePackageLayout(null);
    const destPath = join(makeTempRoot(), ".env");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const created = scaffoldEnv(destPath, moduleUrl);

      expect(created).toBe(false);
      expect(existsSync(destPath)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(".env.example"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("shipped .env.example — real package layout", () => {
  it("the real .env.example is discoverable from init.ts's own module URL", () => {
    // Regression pin: whatever the source-of-truth location is (repo root
    // pre-postbuild, `packages/connector/` post-postbuild, or `node_modules/
    // @mcp-shim/connector/` post-publish), `findShippedEnvExample()` must
    // find SOMETHING that exists on disk. If the `files:` allowlist ever
    // drops `.env.example`, `npm pack` produces a tarball where init would
    // return null in a real customer install — this pin catches the
    // dev-side signal early.
    // Runs against the real module in this repo — no fake layout.
    const resolved = findShippedEnvExample();

    expect(resolved).not.toBeNull();
    expect(existsSync(resolved!)).toBe(true);
    // The filename must be exactly `.env.example` — a fallback that lands
    // on some unrelated file (e.g. `.env`) would silently ship the wrong
    // contents.
    expect(resolved!.endsWith(".env.example")).toBe(true);
  });
});
