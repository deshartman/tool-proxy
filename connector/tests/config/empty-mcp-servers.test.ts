import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../src/config.js";

// mcp_servers: [] is a legitimate posture — the customer uses ONLY drop-ins
// (auto-discovered under MCP_DROPIN_DIR) and/or controller-pushed Type 2
// MCPs (roster arrives over the WS at register-ack). The yaml only owns
// hand-written Type 1 servers, which most deployments don't use.
//
// Pinned here so a future schema tightening (like the .min(1) that once
// blocked the first Fly.io deploy) trips a red build instead of a silent
// prod regression at boot.

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeYaml(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "connector-empty-mcps-"));
  tmpRoots.push(root);
  const path = join(root, "connector.yaml");
  writeFileSync(path, yaml);
  return path;
}

describe("loadConfig — empty mcp_servers is legitimate", () => {
  it("accepts explicit empty array", async () => {
    const path = writeYaml("mcp_servers: []\npolicy:\n  fail_mode: fail_fast\n");
    const cfg = await loadConfig(path);
    expect(cfg.mcp_servers).toEqual([]);
    expect(cfg.policy.fail_mode).toBe("fail_fast");
  });

  it("accepts a yaml with no mcp_servers key at all", async () => {
    const path = writeYaml("policy:\n  fail_mode: fail_fast\n");
    const cfg = await loadConfig(path);
    expect(cfg.mcp_servers).toEqual([]);
  });
});
