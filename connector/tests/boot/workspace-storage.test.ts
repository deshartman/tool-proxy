import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ensureMcpStateDir, removeWorkspaceStorage, workspaceDir, workspaceRoot } from "@connector/boot/workspace-storage.js";

// MULTI-PLATFORM-MCP §5.3 / D15 — per-workspace storage. Pinned: the path is
// ${CONNECTOR_STATE_DIR}/controllers/<entryId>/<mcp>, created 0700; removal
// deletes the whole workspace; and an id or name that is not one we minted can
// never become a path (the id is the one input that came from a hand-editable file).

let stateDir: string;
const env = () => ({ CONNECTOR_STATE_DIR: stateDir }) as NodeJS.ProcessEnv;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "ws-storage-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("workspace storage", () => {
  it("lives under the store's directory, one folder per (workspace, MCP), mode 0700", () => {
    const id = randomUUID();
    const dir = ensureMcpStateDir(id, "agentic-memory", env());
    expect(dir).toBe(join(stateDir, "controllers", id, "agentic-memory"));
    expect(workspaceRoot(env())).toBe(join(stateDir, "controllers"));
    if (process.getuid?.() !== 0) expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("removal deletes the workspace and everything in it, and leaves others alone", () => {
    const a = randomUUID();
    const b = randomUUID();
    writeFileSync(join(ensureMcpStateDir(a, "m", env()), ".state.json"), "{}");
    ensureMcpStateDir(b, "m", env());
    removeWorkspaceStorage(a, env());
    expect(existsSync(workspaceDir(a, env())!)).toBe(false);
    expect(existsSync(workspaceDir(b, env())!)).toBe(true);
  });

  it.each(["../escape", "..", "", "not-a-uuid", `${randomUUID()}/..`])("refuses entry id %j", (id) => {
    expect(workspaceDir(id, env())).toBeUndefined();
    expect(() => ensureMcpStateDir(id, "m", env())).toThrow(/refusing/);
    expect(() => removeWorkspaceStorage(id, env())).not.toThrow();
  });

  it.each(["../x", "a/b", "a.b", ""])("refuses MCP name %j", (name) => {
    expect(() => ensureMcpStateDir(randomUUID(), name, env())).toThrow(/refusing/);
  });
});
