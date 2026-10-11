import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Replaces lifecycle-tdz.test.ts (retired deliberately, MULTI-PLATFORM-MCP
// §5.2). That test guarded bootFromDb's empty-store early return: closures
// wired ABOVE it could fire (the operator submitting Configure Tunnel) while
// bindings declared BELOW it were still in the temporal dead zone.
//
// Phase 6 removed the early return. The empty store is now N = 0 workspaces,
// and every per-tunnel binding is a TunnelWorkspace field initialised in its
// constructor — a workspace cannot exist before its bindings do. What is left
// to pin is the replacement property: adding the first controller AFTER boot
// starts a workspace, through the same path boot uses for stored entries.
//
// A source-level check, like its predecessor: a live boot needs a controller.
// The behaviour itself is exercised end to end by the mock-controller test.

const here = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = readFileSync(join(here, "../../src/boot/lifecycle.ts"), "utf8");
const WORKSPACE = readFileSync(join(here, "../../src/boot/workspace.ts"), "utf8");

function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
}

describe("Phase 6 boot shape", () => {
  const boot = body(LIFECYCLE, "async function bootFromDb");

  it("has no empty-store early return — zero controllers is N = 0, not a branch", () => {
    expect(boot).not.toMatch(/if\s*\(\s*!row\s*\)\s*\{?\s*[^}]*return/);
    expect(boot).not.toMatch(/getController\(\)/);
  });

  it("a controller added after boot starts a workspace (dialTunnel → startWorkspace)", () => {
    expect(boot).toMatch(/dialTunnel:\s*async\s*\(r\)\s*=>\s*\{\s*await startWorkspace\(r\);?\s*\}/);
  });

  it("stored entries start through the same startWorkspace path", () => {
    expect(boot).toMatch(/listControllers\(\)/);
    expect(boot).toMatch(/rows\.map\(\(row\)\s*=>\s*startWorkspace\(row\)/);
  });

  it("removing a controller stops its workspace and deletes its storage", () => {
    const remove = body(LIFECYCLE, "async function removeWorkspace");
    expect(remove).toMatch(/\.stop\(/);
    expect(remove).toMatch(/removeWorkspaceStorage\(id\)/);
  });

  it("a workspace has no module-level mutable state (two workspaces share nothing mutable)", () => {
    // Every `let` in workspace.ts must be inside a function or class body.
    const topLevel = WORKSPACE.split("\n").filter((line) => /^let\s/.test(line));
    expect(topLevel).toEqual([]);
  });
});
