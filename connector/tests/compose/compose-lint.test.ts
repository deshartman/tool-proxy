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
//      expose the bcrypt-protected webhook URLs), and the master key must
//      stay a read-only mount.
//   3. That the Postgres service is GONE and stays gone (DB-TO-FILE). The
//      negative cases matter more than the positive ones here: the stack
//      would still *parse* with a re-added sibling database, and the
//      connector would still boot ignoring it, so nothing else fails loudly.

const REPO_ROOT = resolvePath(new URL("../../../", import.meta.url).pathname);
const COMPOSE_PATH = resolvePath(REPO_ROOT, "deploy/compose/docker-compose.prod.yml");

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
        env: { ...process.env, MCP_VERSION: "test" },
        encoding: "utf8",
      },
    );
    // Assert compose actually rendered the one service we expect.
    expect(output).toMatch(/^\s*connector:/m);
    // Interpolation resolved without errors.
    expect(output).not.toContain("${MCP_VERSION");
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

  it("mounts the master key file read-only", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    // Encryption key must be RO — libsodium's crypto_secretbox reads it
    // once at boot, no legitimate reason to allow container writes.
    expect(contents).toMatch(/connector\.key:\/etc\/mcp-connector\/connector\.key:ro/);
  });

  it("persists the state volume that now holds the sealed identity", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    // Post DB-TO-FILE this volume IS the tunnel identity: config.json holds
    // the sealed bearer and the registration token. A tmpfs or a missing
    // mount would send the operator back through Configure Tunnel on every
    // restart, and collide on `name_taken` at the controller.
    expect(contents).toMatch(/^\s*-\s*state:\/var\/lib\/mcp-connector\s*$/m);
    expect(contents).toMatch(/^volumes:/m);
  });

  it("ships no database service and no DSN env (DB-TO-FILE)", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    // Comments are allowed to mention the word; configuration is not. Strip
    // them before asserting, so the prose above can explain the removal.
    const config = contents
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(config).not.toMatch(/postgres/i);
    expect(config).not.toMatch(/\bpg_password\b/);
    expect(config).not.toMatch(/^\s*secrets:/m);
    expect(config).not.toMatch(/^\s*depends_on:/m);
  });

  it("requires exactly one env var of the operator", () => {
    const contents = readFileSync(COMPOSE_PATH, "utf8");
    expect(contents).toMatch(/CONNECTOR_KEY_FILE:/);
    // The four vars ENV-TO-DB retired, plus the two DB-TO-FILE retired.
    // A generated or hand-edited stack that reintroduces any of them boots
    // fine and ignores them, which is exactly why it needs a test.
    for (const retired of [
      "CONNECTOR_NAME",
      "CONTROLLER_URL",
      "TUNNEL_AUTH_TOKEN",
      "OAUTH_CLIENT_SECRET",
      "POSTGRES_URL_TEMPLATE",
      "POSTGRES_PW_FILE",
    ]) {
      expect(contents).not.toContain(`${retired}:`);
    }
  });
});
