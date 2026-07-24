import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverBundled, discoverDropins, isDropinSpec } from "@connector/dropin.js";
import { authorOf, type McpServerSpec } from "@connector/config.js";

// C4 of CUSTOMER-REPO-CARVE-OUT. discoverBundled scans MCP_BUNDLED_DIR the
// same way discoverDropins scans MCP_DROPIN_DIR, but tags the resulting
// specs with `__author: "twilio"` so authorOf() classifies them as
// Twilio-shipped in the manifest.
//
// D1 (always on): no allowlist parameter — every valid folder under
// MCP_BUNDLED_DIR registers. A customer who explicitly doesn't want a
// bundled MCP removes the folder from their image / mount.

function makeBundleTree(): { dir: string; addBundle: (name: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "bundled-scan-"));
  const addBundle = (name: string): void => {
    const toolsDir = join(dir, name, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "hello.ts"), "export default { name: 'hello' };\n", "utf8");
  };
  return { dir, addBundle };
}

describe("discoverBundled", () => {
  let bundleTree: ReturnType<typeof makeBundleTree>;

  beforeEach(() => {
    bundleTree = makeBundleTree();
  });

  it("returns every valid folder under MCP_BUNDLED_DIR (no allowlist)", () => {
    bundleTree.addBundle("agentic-memory");
    bundleTree.addBundle("enterprise-knowledge");
    bundleTree.addBundle("some-future-bundle");

    const specs = discoverBundled({ bundledDir: bundleTree.dir, yamlNames: new Set() });

    expect(specs.map((s) => s.name).sort()).toEqual([
      "agentic-memory",
      "enterprise-knowledge",
      "some-future-bundle",
    ]);
  });

  it("tags every discovered spec with __author=twilio so authorOf classifies as Twilio-shipped", () => {
    bundleTree.addBundle("agentic-memory");

    const specs = discoverBundled({ bundledDir: bundleTree.dir, yamlNames: new Set() });

    expect(specs).toHaveLength(1);
    expect((specs[0] as { __author?: string }).__author).toBe("twilio");
    expect(authorOf(specs[0] as unknown as McpServerSpec)).toBe("twilio");
  });

  it("marks specs as drop-ins (assignable to McpServerSpec + isDropinSpec === true)", () => {
    bundleTree.addBundle("agentic-memory");

    const specs = discoverBundled({ bundledDir: bundleTree.dir, yamlNames: new Set() });

    expect(isDropinSpec(specs[0])).toBe(true);
  });

  it("skips folders whose name is already declared in the yaml (yaml wins)", () => {
    bundleTree.addBundle("agentic-memory");
    bundleTree.addBundle("enterprise-knowledge");

    const specs = discoverBundled({
      bundledDir: bundleTree.dir,
      yamlNames: new Set(["enterprise-knowledge"]),
    });

    expect(specs.map((s) => s.name)).toEqual(["agentic-memory"]);
  });

  it("returns [] when the bundled dir doesn't exist (safe on a missing mount)", () => {
    const specs = discoverBundled({
      bundledDir: join(tmpdir(), "does-not-exist-" + Math.floor(1e9 * Math.PI)),
      yamlNames: new Set(),
    });

    expect(specs).toEqual([]);
  });

  it("customer drop-in classifier does NOT set __author=twilio (comparison test)", () => {
    bundleTree.addBundle("my-crm");

    const specs = discoverDropins({ dropinDir: bundleTree.dir, yamlNames: new Set() });

    expect(specs).toHaveLength(1);
    expect((specs[0] as { __author?: string }).__author).toBe("customer");
    expect(authorOf(specs[0] as unknown as McpServerSpec)).toBe("customer");
  });
});
