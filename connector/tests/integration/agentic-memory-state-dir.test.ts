import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// MULTI-PLATFORM-MCP §5.3 — MCP_STATE_DIR is the connector's write contract:
// one directory per (workspace, MCP), injected by the supervisor. agentic-memory
// is the only bundled state writer, so it must prefer that directory over the
// pre-Phase-6 AGENTIC_MEMORY_STATE_PATH, or two controllers' memory would share
// one file. defaultStatePath() is read per call, so no module re-import is needed.

const DROPIN_DIR = resolve(__dirname, "../../..", "bundled-mcps/agentic-memory");
type StateMod = { defaultStatePath: () => string };

const saved = { dir: process.env.MCP_STATE_DIR, path: process.env.AGENTIC_MEMORY_STATE_PATH };
afterEach(() => {
  if (saved.dir === undefined) delete process.env.MCP_STATE_DIR; else process.env.MCP_STATE_DIR = saved.dir;
  if (saved.path === undefined) delete process.env.AGENTIC_MEMORY_STATE_PATH; else process.env.AGENTIC_MEMORY_STATE_PATH = saved.path;
});

describe("agentic-memory state path", () => {
  it("prefers MCP_STATE_DIR over AGENTIC_MEMORY_STATE_PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-statedir-"));
    try {
      process.env.AGENTIC_MEMORY_STATE_PATH = "/should/not/be/used.json";
      process.env.MCP_STATE_DIR = dir;
      const mod = (await import(`${DROPIN_DIR}/state.ts`)) as StateMod;
      expect(mod.defaultStatePath()).toBe(join(dir, ".state.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to AGENTIC_MEMORY_STATE_PATH when MCP_STATE_DIR is unset or empty", async () => {
    process.env.AGENTIC_MEMORY_STATE_PATH = "/tmp/legacy/.state.json";
    process.env.MCP_STATE_DIR = "";
    const mod = (await import(`${DROPIN_DIR}/state.ts`)) as StateMod;
    expect(mod.defaultStatePath()).toBe("/tmp/legacy/.state.json");
  });
});
