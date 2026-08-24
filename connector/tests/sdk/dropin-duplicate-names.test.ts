import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCategory, isToolShape } from "@connector/sdk/dropin-discovery.js";
import type { Tool } from "@connector/sdk/tool.js";

// MCP-AUDIT #15 — a duplicate tool NAME used to be dropped in complete silence.
// The branch was `if (picked && !duplicate) push; else if (!picked) warn;` — three
// cases, two branches, and the middle one (picked but duplicate) matched neither.
// The author's only clue was the tool's absence from the manifest.

let dir: string;

function writeTool(name: string, file: string): void {
  writeFileSync(
    join(dir, "tools", file),
    `export default { name: ${JSON.stringify(name)}, register() {} };\n`,
  );
}

function mkLog() {
  const warn = vi.fn();
  const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), level: "info", child: () => log };
  return { log: log as unknown as Parameters<typeof loadCategory>[4], warn };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dup-tools-"));
  mkdirSync(join(dir, "tools"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MCP-AUDIT #15 — duplicate names are reported, not swallowed", () => {
  it("keeps the first and warns naming both the file and the clashing name", async () => {
    writeTool("get_customer", "a-first.ts");
    writeTool("get_customer", "b-second.ts");
    const { log, warn } = mkLog();

    const tools = await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);
    expect(tools.map((t) => t.name)).toEqual(["get_customer"]);

    const dup = warn.mock.calls.find((c) => String(c[1]).includes("duplicate"));
    expect(dup, "a duplicate name must produce a warning").toBeDefined();
    expect((dup?.[0] as { name: string }).name).toBe("get_customer");
    expect((dup?.[0] as { file: string }).file).toBe("tools/b-second.ts");
  });

  it("still warns separately for a file with no default export", async () => {
    writeFileSync(join(dir, "tools", "empty.ts"), "export const notATool = 42;\n");
    const { log, warn } = mkLog();
    await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("no tool default-export"))).toBe(true);
  });

  it("does not warn when every name is distinct", async () => {
    writeTool("alpha", "alpha.ts");
    writeTool("beta", "beta.ts");
    const { log, warn } = mkLog();
    const tools = await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
