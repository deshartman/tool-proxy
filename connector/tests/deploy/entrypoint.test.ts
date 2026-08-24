import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load-bearing shell entrypoint for the OCI image. Pinned here so a
// refactor that breaks either branch (env-set decode / env-unset no-op)
// trips a red build, not a silent deploy regression.
//
// See CODE-DEPLOY design record §"D2 — Master key delivery".

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../entrypoint.sh");

function scaffoldStubExec(dir: string): void {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });

  // Stub su-exec: drops "mcp:mcp" argument and execs the rest
  const suExec = join(binDir, "su-exec");
  writeFileSync(suExec, '#!/bin/sh\nshift\nexec "$@"\n');
  spawnSync("chmod", ["+x", suExec]);

  // Stub chown: no-op stub for chown mcp:mcp
  const chown = join(binDir, "chown");
  writeFileSync(chown, '#!/bin/sh\nexit 0\n');
  spawnSync("chmod", ["+x", chown]);

  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "dist/index.js"),
    'process.stdout.write("STUB_" + process.argv.slice(2).join(" "))'
  );
}

describe("entrypoint.sh", () => {
  it("no-op when CONNECTOR_KEY_B64 is unset — key file not created; CMD passes through", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-unset-"));
    try {
      scaffoldStubExec(dir);
      const keyFile = join(dir, "key");
      const res = spawnSync(SCRIPT, ["start"], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: undefined } as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("STUB_start");
      expect(existsSync(keyFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-op when CONNECTOR_KEY_B64='' (empty string treated same as unset)", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-empty-"));
    try {
      scaffoldStubExec(dir);
      const keyFile = join(dir, "key");
      const res = spawnSync(SCRIPT, ["start"], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: "" },
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(existsSync(keyFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decodes CONNECTOR_KEY_B64 into CONNECTOR_KEY_FILE — 32 bytes, exact content", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-set-"));
    try {
      scaffoldStubExec(dir);
      const keyFile = join(dir, "key");
      const bytes = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 13) & 0xff;
      const b64 = bytes.toString("base64");

      const res = spawnSync(SCRIPT, ["start"], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: b64 },
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(existsSync(keyFile)).toBe(true);
      expect(readFileSync(keyFile)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory for CONNECTOR_KEY_FILE if missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-mkdir-"));
    try {
      scaffoldStubExec(dir);
      const keyFile = join(dir, "nested", "deeper", "key");
      const b64 = Buffer.alloc(32, 0xa5).toString("base64");

      const res = spawnSync(SCRIPT, ["start"], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: b64 },
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(existsSync(keyFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unsets CONNECTOR_KEY_B64 and invokes su-exec", () => {
    const scriptContent = readFileSync(SCRIPT, "utf8");
    expect(scriptContent).toMatch(/unset\s+CONNECTOR_KEY_B64/);
    expect(scriptContent).toMatch(/exec\s+su-exec\s+mcp:mcp\s+node\s+dist\/index\.js/);
  });
});

// The state volume is mounted OVER /var/lib/mcp-connector at runtime, which
// discards the Dockerfile's `mkdir -p customer-mcps` + `chown -R mcp:mcp` on
// that path. Fly mounts it root:root 0755; a K8s PVC and a raw EFS mount do
// the same. The connector then runs as mcp against a root-owned directory and
// cannot create anything, so agentic-memory's state write fails EACCES — but
// LAZILY, on the first memory write, long after a clean boot. The entrypoint
// re-provisions while it is still root.
//
// deploy/DERIVED-IMAGE.md documented this masking pitfall for derived images
// before it was noticed that deploy/fly/fly.toml mounts at exactly that path.
describe("entrypoint.sh — state volume provisioning", () => {
  const script = readFileSync(SCRIPT, "utf8");

  it("does not abort boot when the state volume is absent", () => {
    // The guard is `[ -d "$state_dir" ]`. Under `set -eu` a missing guard, or a
    // bare mkdir/chown on a path that cannot be written, would kill boot for
    // every non-volume deployment (compose with a bind mount, a plain VM).
    // This is the single most important regression to pin.
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-novol-"));
    try {
      scaffoldStubExec(dir);
      const res = spawnSync("sh", [SCRIPT, "start"], {
        cwd: dir,
        env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("STUB_start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provisions both directories the connector needs on the volume", () => {
    // agentic-memory/ — mcp must own the DIRECTORY, since saveState writes a
    //                   sibling .tmp and renames over the target.
    // customer-mcps/  — drop-in scanner's default root; discovery must find an
    //                   empty dir rather than a missing path.
    expect(script).toMatch(/for d in agentic-memory customer-mcps/);
    expect(script).toMatch(/chown mcp:mcp "\$state_dir\/\$d"/);
  });

  it("runs the provisioning BEFORE dropping privileges", () => {
    // chown needs root. After the su-exec line this would be dead code that
    // still looks correct in review.
    const provision = script.indexOf('state_dir="/var/lib/mcp-connector"');
    const drop = script.indexOf("exec su-exec");
    expect(provision).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(-1);
    expect(provision).toBeLessThan(drop);
  });

  it("never recursively chowns the volume root", () => {
    // Least privilege, matching the deliberately root-owned /app tree: the
    // volume root stays root-owned so a compromised child cannot litter the
    // volume or plant a drop-in for the next boot. A `chown -R` on the root
    // would also rewrite a customer's read-only customer-mcps bind mount.
    // Comment lines are excluded: the block's own comment QUOTES the
    // Dockerfile's `chown -R mcp:mcp /var/lib/mcp-connector` to explain why
    // re-provisioning is needed, and matching that would fail spuriously.
    const code = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/chown\s+-R/);
  });

  it("tolerates a read-only mount instead of failing the boot", () => {
    // A pre-provisioned or read-only mount is a valid setup, so both commands
    // must have a fallback rather than inheriting `set -e`.
    const block = script.slice(
      script.indexOf('state_dir="/var/lib/mcp-connector"'),
      script.indexOf("exec su-exec"),
    );
    const guarded = block.split("\n").filter((l) => /mkdir -p|chown mcp:mcp/.test(l));
    expect(guarded.length).toBe(2);
    for (const line of guarded) {
      // The `||` fallback sits on the continuation line, so assert on the block.
      expect(block).toContain("|| echo");
    }
    expect(block).toMatch(/2>\/dev\/null/);
  });
});
