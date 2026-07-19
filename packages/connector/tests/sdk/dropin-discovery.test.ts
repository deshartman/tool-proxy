import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadCategory,
  loadCapabilities,
  isToolShape,
  isPromptShape,
  isResourceShape,
} from "@connector/sdk/dropin-discovery.js";
import { createLogger } from "@connector/logger.js";
import type { Tool } from "@connector/sdk/tool.js";
import type { Prompt } from "@connector/sdk/prompt.js";
import type { Resource } from "@connector/sdk/resource.js";

// S5 of MCP-SHIM-MERGE.md. The drop-in runner used to scan only tools/*.{ts,js}.
// CLIENT-USE landed prompts/ and resources/ as new authoring surfaces; LOCAL
// deleted the per-folder server.ts. The merge wires the third leg: drop-in
// folders now also scan prompts/ and resources/ siblings of tools/. Pin the
// behaviour here so a future refactor can't silently drop one of the legs.

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "dropin-discovery-"));
}

function writeFixture(dir: string, subdir: string, file: string, content: string): void {
  const full = join(dir, subdir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, file), content);
}

const log = createLogger("dropin-discovery-test");

describe("dropin discovery — prompts and resources siblings of tools/", () => {
  it("picks up tools/, prompts/, and resources/ siblings independently", async () => {
    const dir = makeFixtureDir();
    writeFixture(dir, "tools", "ping.js", `
      export const ping = {
        name: "ping",
        register(server) {},
      };
      export default ping;
    `);
    writeFixture(dir, "prompts", "hello.js", `
      export const hello = {
        name: "hello",
        register(server) {},
      };
      export default hello;
    `);
    writeFixture(dir, "resources", "readme.js", `
      export const readme = {
        name: "readme",
        register(server) {},
      };
      export default readme;
    `);

    const tools = await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);
    const prompts = await loadCategory<Prompt>(dir, "prompts", "prompt", isPromptShape, log);
    const resources = await loadCategory<Resource>(dir, "resources", "resource", isResourceShape, log);

    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    expect(prompts.map((p) => p.name)).toEqual(["hello"]);
    expect(resources.map((r) => r.name)).toEqual(["readme"]);
  });

  it("returns [] for missing subdirectories — preserves today's tools-only authoring shape", async () => {
    // A drop-in folder with no prompts/ or resources/ siblings is the existing
    // shape. loadCategory must NOT throw / crash; it returns []. Without this,
    // every customer with a tools-only drop-in would regress at boot.
    const dir = makeFixtureDir();
    writeFixture(dir, "tools", "only.js", `
      export const only = {
        name: "only",
        register(server) {},
      };
      export default only;
    `);

    const tools = await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);
    const prompts = await loadCategory<Prompt>(dir, "prompts", "prompt", isPromptShape, log);
    const resources = await loadCategory<Resource>(dir, "resources", "resource", isResourceShape, log);

    expect(tools.map((t) => t.name)).toEqual(["only"]);
    expect(prompts).toEqual([]);
    expect(resources).toEqual([]);
  });

  it("falls back to the first named export when there's no default", async () => {
    // Matches the convention pinned by the existing pickShape behavior — one
    // item per file, exported either as default or as a named export with the
    // shape. Authors writing `export const foo = {...}` (no default) still
    // work.
    const dir = makeFixtureDir();
    writeFixture(dir, "prompts", "named-only.js", `
      export const namedPrompt = {
        name: "named",
        register(server) {},
      };
    `);

    const prompts = await loadCategory<Prompt>(dir, "prompts", "prompt", isPromptShape, log);

    expect(prompts.map((p) => p.name)).toEqual(["named"]);
  });

  it("loadCapabilities returns the default-exported object when capabilities.ts is present", async () => {
    // Extension surface for protocol shapes like MEMORY-MCP-INTERFACE.md §7 —
    // the drop-in folder can advertise custom capability groups on the MCP
    // initialize response by dropping a capabilities.{ts,js} next to
    // tools/. Nested under experimental to survive the SDK's schema strip.
    const dir = makeFixtureDir();
    writeFileSync(join(dir, "capabilities.js"), `
      export default {
        experimental: {
          "test-provider": { protocolVersion: "test-1", identity: { supported: true } }
        }
      };
    `);

    const caps = await loadCapabilities(dir, log);
    expect(caps).toEqual({
      experimental: {
        "test-provider": { protocolVersion: "test-1", identity: { supported: true } },
      },
    });
  });

  it("loadCapabilities returns undefined when no capabilities file exists — the today's tools-only shape is unchanged", async () => {
    const dir = makeFixtureDir();
    writeFixture(dir, "tools", "only.js", `
      export const only = { name: "only", register(server) {} };
      export default only;
    `);

    const caps = await loadCapabilities(dir, log);
    expect(caps).toBeUndefined();
  });

  it("skips files that don't export a matching shape — no crash, just a warn", async () => {
    // A bad file (no register fn / wrong shape) must not abort the scan of the
    // sibling files. Per-file isolation is the property here.
    const dir = makeFixtureDir();
    writeFixture(dir, "tools", "good.js", `
      export const good = { name: "good", register(server) {} };
      export default good;
    `);
    writeFixture(dir, "tools", "bad.js", `
      export const notATool = { somethingElse: 42 };
      export default notATool;
    `);

    const tools = await loadCategory<Tool>(dir, "tools", "tool", isToolShape, log);

    expect(tools.map((t) => t.name)).toEqual(["good"]);
  });
});
