import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns, SpawnSyncOptions } from "node:child_process";

import { applyFly, runDeployApply, type SpawnFn } from "../../src/deploy/apply.js";

// applyFly spawns `fly` commands directly (native Node — no bash script).
// Under native ESM `vi.spyOn` on child_process.spawnSync doesn't work
// (module namespace not configurable), so applyFly takes an injectable
// `spawn` parameter. Tests supply a scripted fake that returns different
// canned responses per (command, args) pattern.

const FLY_TOML_CONTENT = `app = "twilio-tool-sdk"
primary_region = "iad"

[build]
  dockerfile = "connector/Dockerfile"
`;

interface FakeCall {
  command: string;
  args: readonly string[];
  options?: SpawnSyncOptions;
}

interface FakeResponse {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

// A recording spawn that matches (command, args) against a response map.
// If no match, returns { status: 0, stdout: "", stderr: "" } — a safe
// default so tests that don't care about a specific step don't fail.
function makeSpawn(responses: Array<{ match: (call: FakeCall) => boolean; response: FakeResponse }>): {
  spawn: SpawnFn;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const spawn: SpawnFn = ((command: string, args: readonly string[], options?: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    const match = responses.find((r) => r.match({ command, args, options }));
    const r = match?.response ?? {};
    return {
      status: r.status ?? 0,
      stdout: Buffer.from(r.stdout ?? ""),
      stderr: Buffer.from(r.stderr ?? ""),
      pid: 12345,
      output: [],
      signal: null,
      error: r.error,
    } as SpawnSyncReturns<Buffer>;
  }) as SpawnFn;
  return { spawn, calls };
}

function isFlyCmd(subcmd: string) {
  return (c: FakeCall) => c.command === "fly" && c.args[0] === subcmd;
}

describe("applyFly — preflight", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "apply-fly-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("returns exit 1 when fly.toml is missing", () => {
    const { spawn, calls } = makeSpawn([]);
    expect(applyFly(outDir, spawn)).toBe(1);
    // MUST NOT have spawned any fly command — preflight bails first.
    expect(calls).toHaveLength(0);
  });

  it("returns exit 1 when flyctl (fly binary) is not on PATH", () => {
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), FLY_TOML_CONTENT);
    // Simulate `fly version` failing — spawn returns error (ENOENT-like).
    const { spawn } = makeSpawn([
      { match: (c) => c.command === "fly" && c.args[0] === "version", response: { error: new Error("ENOENT") } },
    ]);
    expect(applyFly(outDir, spawn)).toBe(1);
  });

  it("returns exit 1 when fly.toml is malformed (no app/region)", () => {
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), "# not a real toml\n");
    const { spawn } = makeSpawn([
      { match: (c) => c.command === "fly" && c.args[0] === "version", response: { status: 0 } },
    ]);
    expect(applyFly(outDir, spawn)).toBe(1);
  });

  it("creates deploy/fly/connector.yaml if missing (fly.toml [[files]] block needs it)", () => {
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), FLY_TOML_CONTENT);
    // Provide happy responses for every fly command so applyFly proceeds
    // through to the connector.yaml preflight step.
    const { spawn } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      // apps list — return with the app already existing so we skip creates
      { match: isFlyCmd("apps"), response: { stdout: `[{"Name":"twilio-tool-sdk"},{"Name":"twilio-tool-sdk-db"}]` } },
      // secrets list — return with the key already set
      { match: isFlyCmd("secrets"), response: { stdout: "CONNECTOR_KEY_B64      abc      2026-07-23\n" } },
      // volumes list — return with state volume already present
      { match: isFlyCmd("volumes"), response: { stdout: `[{"Name":"state"}]` } },
      // fly deploy — succeed
      { match: (c) => c.args[0] === "deploy", response: { status: 0 } },
    ]);

    applyFly(outDir, spawn);

    // Post-condition: connector.yaml was auto-created
    const created = join(outDir, "deploy", "fly", "connector.yaml");
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(created, "utf8")).toContain("mcp_servers: []");
  });
});

describe("applyFly — happy path", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "apply-fly-happy-"));
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), FLY_TOML_CONTENT);
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true });
    writeFileSync(
      join(outDir, "deploy", "fly", "connector.yaml"),
      "mcp_servers: []\npolicy:\n  fail_mode: fail_fast\n",
    );
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("spawns all 4 fly commands in order when nothing exists", () => {
    const { spawn, calls } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      // Both apps list calls return empty — nothing exists
      { match: isFlyCmd("apps"), response: { stdout: `[]` } },
      // secrets list — no keys set yet
      { match: isFlyCmd("secrets"), response: { stdout: "" } },
      // volumes list — no volumes yet
      { match: isFlyCmd("volumes"), response: { stdout: `[]` } },
      // All mutating commands succeed
      { match: (c) => c.args.includes("create") || c.args.includes("set") || c.args[0] === "deploy", response: { status: 0 } },
    ]);

    expect(applyFly(outDir, spawn)).toBe(0);

    // Order matters: preflight → apps create → secrets set → volumes create
    // → fly deploy. DB-TO-FILE removed the two postgres steps that used to
    // sit between apps create and secrets set.
    const mutations = calls.filter((c) =>
      c.args.includes("create") || c.args[1] === "set" || c.args[0] === "deploy"
    );
    expect(mutations).toHaveLength(4);
    expect(mutations[0].args).toEqual(["apps", "create", "twilio-tool-sdk"]);
    expect(mutations[1].args[0]).toBe("secrets");
    expect(mutations[1].args[1]).toBe("set");
    expect(mutations[2].args.slice(0, 3)).toEqual(["volumes", "create", "state"]);
    expect(mutations[3].args).toEqual(["deploy", "-c", "deploy/fly/fly.toml"]);
  });

  it("prints an explicit next-steps block to stdout on success", () => {
    // Operators forget the relay + proxy pair. Pino log lines land as noise
    // after the deploy output, so the CLI writes a plain-text summary block
    // DIRECTLY to stdout (bypassing the pino formatter) with the exact
    // commands, HSTS warning, and Configure Tunnel instructions. This test
    // pins that: the block MUST appear.
    //
    // These assertions were INVERTED. They used to pin
    // `fly proxy 9090:9090`, which stopped reaching the dashboard when the
    // request gate landed (2026-08-08) and the admin session was removed
    // (7c8d8ad, 08-09): fly proxy arrives from the Machine's fdaa: mesh
    // address, and every route outside the four machine-API paths requires
    // a loopback caller. So the CLI's headline instruction was 403-ing while
    // a green test guaranteed it was printed verbatim.
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { spawn } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      { match: isFlyCmd("apps"), response: { stdout: `[{"Name":"twilio-tool-sdk"},{"Name":"twilio-tool-sdk-db"}]` } },
      { match: isFlyCmd("secrets"), response: { stdout: "CONNECTOR_KEY_B64  x\n" } },
      { match: isFlyCmd("volumes"), response: { stdout: `[{"Name":"state"}]` } },
    ]);

    expect(applyFly(outDir, spawn)).toBe(0);

    const stdoutText = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // One command, with the app name substituted — the relay/proxy pair and
    // its teardown live in the script, not in this block.
    expect(stdoutText).toContain("./scripts/fly-inspector.sh twilio-tool-sdk");
    // The operator must be told why `fly proxy` alone fails, or the 403 reads
    // as a broken Inspector and they go looking in the wrong place.
    expect(stdoutText).toContain("forbidden: loopback only");
    expect(stdoutText).not.toContain("fly proxy 9090:9090");
    // And that API clients are not the answer — the Network Access panel is
    // the first place an operator reasonably looks.
    expect(stdoutText).toContain("Network Access panel does NOT help");
    // The HSTS warning must be there — recurring source of "why doesn't
    // localhost:9090 work" support questions.
    expect(stdoutText).toContain("Chrome HSTS");
    // "Next steps" heading — makes the block scannable.
    expect(stdoutText).toContain("Next steps");
    // Post-deploy invariant check must be mentioned.
    expect(stdoutText).toContain("fly ips list -a twilio-tool-sdk");
    // Port collisions are handled by the script (it probes both sides), so
    // this block no longer needs to teach a fallback command.
    vi.restoreAllMocks();
  });

  it("never invokes `fly postgres` at all (DB-TO-FILE)", () => {
    // Was: "attaches Postgres with --variable-name POSTGRES_URL (Bug B3)",
    // pinning that Fly's default DATABASE_URL name would break boot. The
    // whole subsystem is gone — the connector's store is a sealed JSON file
    // on the state volume — so the assertion inverts.
    //
    // This is the expensive one to get wrong: `fly postgres create`
    // provisions a separate BILLABLE app named `<app>-db`, so a reintroduced
    // step costs money silently and collides on that name for a second
    // connector in the same org.
    const { spawn, calls } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      { match: isFlyCmd("apps"), response: { stdout: `[]` } },
      { match: isFlyCmd("secrets"), response: { stdout: "" } },
      { match: isFlyCmd("volumes"), response: { stdout: `[]` } },
    ]);

    applyFly(outDir, spawn);

    expect(calls.find((c) => c.args[0] === "postgres")).toBeUndefined();
    expect(calls.find((c) => c.args.some((a) => a.includes("POSTGRES")))).toBeUndefined();
    // And nothing reaches for the `<app>-db` name either.
    expect(calls.find((c) => c.args.some((a) => a.endsWith("-db")))).toBeUndefined();
  });

  it("mints a 32-byte base64 key when CONNECTOR_KEY_B64 is not set", () => {
    const { spawn, calls } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      { match: isFlyCmd("apps"), response: { stdout: `[]` } },
      { match: isFlyCmd("secrets"), response: { stdout: "" } },
      { match: isFlyCmd("volumes"), response: { stdout: `[]` } },
    ]);
    applyFly(outDir, spawn);

    const setKey = calls.find((c) => c.args[0] === "secrets" && c.args[1] === "set");
    expect(setKey).toBeDefined();
    const keyArg = setKey!.args.find((a) => a.startsWith("CONNECTOR_KEY_B64="));
    expect(keyArg).toBeDefined();
    // Base64 of 32 raw bytes → 44 chars (32*4/3 rounded up, padded to /4).
    const value = keyArg!.slice("CONNECTOR_KEY_B64=".length);
    expect(value.length).toBe(44);
    // Base64 alphabet + padding
    expect(value).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("applyFly — idempotency", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "apply-fly-idem-"));
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), FLY_TOML_CONTENT);
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true });
    writeFileSync(join(outDir, "deploy", "fly", "connector.yaml"), "mcp_servers: []\n");
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("skips create-app when the app already exists", () => {
    const { spawn, calls } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      // App already exists in the list
      { match: isFlyCmd("apps"), response: { stdout: `[{"Name":"twilio-tool-sdk"},{"Name":"twilio-tool-sdk-db"}]` } },
      { match: isFlyCmd("secrets"), response: { stdout: "CONNECTOR_KEY_B64  x\n" } },
      { match: isFlyCmd("volumes"), response: { stdout: `[{"Name":"state"}]` } },
    ]);

    applyFly(outDir, spawn);

    // No `apps create` invocation
    expect(calls.find((c) => c.args[0] === "apps" && c.args[1] === "create")).toBeUndefined();
    // No `postgres` invocation of any kind — see the dedicated test above.
    expect(calls.find((c) => c.args[0] === "postgres")).toBeUndefined();
    // No `secrets set` invocation
    expect(calls.find((c) => c.args[0] === "secrets" && c.args[1] === "set")).toBeUndefined();
    // No `volumes create` invocation
    expect(calls.find((c) => c.args[0] === "volumes" && c.args[1] === "create")).toBeUndefined();
    // But `fly deploy` STILL runs — that's the point of re-run.
    expect(calls.find((c) => c.args[0] === "deploy")).toBeDefined();
  });
});

describe("applyFly — deploy failure propagation", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "apply-fly-fail-"));
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true }); writeFileSync(join(outDir, "deploy", "fly", "fly.toml"), FLY_TOML_CONTENT);
    mkdirSync(join(outDir, "deploy", "fly"), { recursive: true });
    writeFileSync(join(outDir, "deploy", "fly", "connector.yaml"), "mcp_servers: []\n");
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("propagates a non-zero exit code from fly deploy", () => {
    // CI wrappers gate on this. If the wrapper always returned 0 regardless
    // of the actual deploy outcome, failed deploys would look green.
    const { spawn } = makeSpawn([
      { match: isFlyCmd("version"), response: { status: 0 } },
      { match: isFlyCmd("apps"), response: { stdout: `[{"Name":"twilio-tool-sdk"},{"Name":"twilio-tool-sdk-db"}]` } },
      { match: isFlyCmd("secrets"), response: { stdout: "CONNECTOR_KEY_B64  x\n" } },
      { match: isFlyCmd("volumes"), response: { stdout: `[{"Name":"state"}]` } },
      { match: (c) => c.args[0] === "deploy", response: { status: 42 } },
    ]);
    expect(applyFly(outDir, spawn)).toBe(42);
  });
});

describe("runDeployApply (CLI parsing)", () => {
  it("requires --target", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runDeployApply([]);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--target is required"));
    vi.restoreAllMocks();
  });

  it("rejects unknown targets with a helpful error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runDeployApply(["--target", "gcp-run"]);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown target "gcp-run"'));
    vi.restoreAllMocks();
  });

  it("prints the not-implemented notice for future targets", async () => {
    // fargate/gke/aca/compose don't have a deploy apply yet — the CLI must
    // acknowledge them (they ARE valid deploy init targets) but exit 2 with
    // a pointer to deploy init + apply-with-native-tool.
    for (const target of ["fargate", "gke", "aca", "compose", "fly-mock"] as const) {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const code = await runDeployApply(["--target", target]);
      expect(code, `${target} should exit 2`).toBe(2);
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(stderrText).toContain("not yet implemented");
      expect(stderrText).toContain(target);
      vi.restoreAllMocks();
    }
  });

  it("prints --help when asked", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runDeployApply(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("mcp-connector deploy apply"));
    vi.restoreAllMocks();
  });
});
