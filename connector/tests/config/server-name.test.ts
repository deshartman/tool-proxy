import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { isValidServerName } from "../../src/identity/server-name.js";

// MULTI-PLATFORM-MCP §3.4. One server-name rule for every source. Previously
// only the drop-in scanner enforced it; a yaml entry with a '.' loaded fine and
// then broke the dispatcher's server/tool split.

function writeYaml(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "server-name-"));
  const path = join(dir, "connector.yaml");
  writeFileSync(path, `mcp_servers:\n  - name: "${name}"\n    transport: http\n    endpoint: http://127.0.0.1:9999/mcp\n`, "utf8");
  return path;
}

describe("server-name rule", () => {
  it("accepts every name the repo ships", () => {
    for (const ok of ["agentic-memory", "crm", "salesforce", "sample", "a1", "x_y"]) {
      expect(isValidServerName(ok)).toBe(true);
    }
  });

  it("rejects dots and other routing-breaking shapes", () => {
    for (const bad of ["crm.sales", "", "-lead", "_lead", "a b", "a/b"]) {
      expect(isValidServerName(bad)).toBe(false);
    }
  });

  it("loadConfig rejects a yaml server name containing a dot, naming the rule", () => {
    expect(() => loadConfig(writeYaml("crm.sales"))).toThrow(/no '\.'/);
  });

  it("loadConfig still accepts a valid yaml server name", () => {
    expect(loadConfig(writeYaml("crm-sales")).mcp_servers[0].name).toBe("crm-sales");
  });
});
