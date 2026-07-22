import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// The docker-compose.prod.yml ships as an operator-runnable file, not a
// documentation blob. This test asserts:
//   1. `docker compose config` parses it cleanly (structure + expected
//      env-var interpolation). Skipped when docker isn't available.
//   2. Load-bearing invariants that would silently break in review:
//      the inspector port must bind 127.0.0.1 only (leaking it would
//      expose the bcrypt-protected webhook URLs), and the postgres
//      password is sourced from a file secret, not committed inline.

const REPO_ROOT = resolvePath(new URL("../../../../", import.meta.url).pathname);
const COMPOSE_PATH = resolvePath(REPO_ROOT, "docker-compose.prod.yml");

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("docker-compose.prod.yml", () => {
  it("exists at the repo root", () => {
    expect(existsSync(COMPOSE_PATH)).toBe(true);
  });

  const testFn = dockerAvailable() ? it : it.skip;

  testFn("parses cleanly via `docker compose config`", () => {
    const output = execFileSync(
      "docker",
      ["compose", "-f", COMPOSE_PATH, "config"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MCP_VERSION: "test",
          POSTGRES_PASSWORD: "test-pw",
        },
        encoding: "utf8",
      },
    );
    // Assert compose actually rendered the services we expect.
    expect(output).toMatch(/^\s*connector:/m);
    expect(output).toMatch(/^\s*postgres:/m);
    // Interpolation resolved without errors.
    expect(output).not.toContain("${MCP_VERSION");
    expect(output).not.toContain("${POSTGRES_PASSWORD");
  });

  it("binds the inspector port to loopback only", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    // Load-bearing per CLAUDE.md's "Inspector port is localhost-only":
    // any binding that resolves to 0.0.0.0 would leak the bcrypt-protected
    // webhook URL to the network.
    expect(contents).toContain(`"127.0.0.1:9090:9090"`);
    expect(contents).not.toMatch(/^\s*-\s*"?0\.0\.0\.0:9090/m);
    expect(contents).not.toMatch(/^\s*-\s*"?9090:9090/m); // implicit 0.0.0.0
  });

  it("sources the postgres password from a file secret, never inline", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    expect(contents).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/pg_password");
    // An accidental POSTGRES_PASSWORD env with a literal would defeat the
    // secrets: block. Only the URL-scoped interpolation is allowed
    // (POSTGRES_URL: ...:${POSTGRES_PASSWORD}@...).
    expect(contents).not.toMatch(/^\s*POSTGRES_PASSWORD:\s*[^$\s]/m);
  });

  it("mounts the master key file read-only", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    // Encryption key must be RO — libsodium's crypto_secretbox reads it
    // once at boot, no legitimate reason to allow container writes.
    expect(contents).toMatch(/connector\.key:\/etc\/mcp-connector\/connector\.key:ro/);
  });
});
