import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

import { applyFly, runDeployApply, type SpawnFn } from "../../src/deploy/apply.js";

// applyFly() shells out to fly-deploy.sh from a given cwd. Native ESM
// blocks vi.spyOn on child_process.spawnSync (module namespace isn't
// configurable) — so applyFly accepts a `spawn` parameter for injection.
// Tests supply a fake and assert on its call shape.

function fakeSpawn(returnValue: Partial<SpawnSyncReturns<Buffer>>): SpawnFn {
  const base: SpawnSyncReturns<Buffer> = {
    status: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    pid: 12345,
    output: [],
    signal: null,
  };
  return vi.fn(() => ({ ...base, ...returnValue })) as unknown as SpawnFn;
}

describe("applyFly", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "apply-fly-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns exit 1 when fly-deploy.sh is missing", () => {
    // Empty tmpdir — no fly-deploy.sh. The wrapper must refuse to spawn
    // (else operators get a confusing bash error about the missing file
    // instead of a clear "run deploy init first" hint).
    const spawn = fakeSpawn({});
    const code = applyFly(outDir, spawn);
    expect(code).toBe(1);
    // Must NOT have attempted to spawn bash when the script is absent.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns bash with fly-deploy.sh path and propagates exit code", () => {
    writeFileSync(join(outDir, "fly-deploy.sh"), "#!/usr/bin/env bash\nexit 0\n");
    const spawn = fakeSpawn({ status: 0 });

    const code = applyFly(outDir, spawn);

    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("bash");
    expect(args).toEqual([join(outDir, "fly-deploy.sh")]);
    // stdio must be "inherit" so operators see build progress live. If this
    // regressed to "pipe" the operator would see NOTHING until fly-deploy.sh
    // exits — replicating the Bug B5 buffering problem we just solved.
    expect(opts).toMatchObject({ cwd: outDir, stdio: "inherit" });
  });

  it("propagates a non-zero exit code from fly-deploy.sh", () => {
    writeFileSync(join(outDir, "fly-deploy.sh"), "#!/usr/bin/env bash\nexit 42\n");
    const spawn = fakeSpawn({ status: 42 });

    // CI wrappers gate on this exit code — if the wrapper always returned 0
    // regardless of the script's outcome, failed deploys would look green.
    expect(applyFly(outDir, spawn)).toBe(42);
  });

  it("returns exit 1 when bash spawn itself errors (e.g. bash not on PATH)", () => {
    writeFileSync(join(outDir, "fly-deploy.sh"), "#!/usr/bin/env bash\nexit 0\n");
    const spawn = fakeSpawn({
      status: null,
      pid: 0,
      error: new Error("ENOENT: bash not found"),
    });

    // Distinguishes "bash could not be spawned" from "bash ran and returned
    // a non-zero code". Both are exit 1 to the caller today, but a specific
    // error log helps operators diagnose.
    expect(applyFly(outDir, spawn)).toBe(1);
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
