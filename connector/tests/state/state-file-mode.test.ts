import { describe, it, expect } from "vitest";
import { statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState } from "../../src/state.js";

describe("state file permission mode", () => {
  it("writes .connector-state.json with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-mode-"));
    const statePath = join(dir, ".connector-state.json");
    try {
      writeState({ registrationToken: "test-token" }, statePath);
      const stat = statSync(statePath);
      expect(stat.mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
