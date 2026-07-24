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
// See architectural-plans/CODE-DEPLOY.md §"D2 — Master key delivery".

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../entrypoint.sh");

function scaffoldStubExec(dir: string): void {
  // The entrypoint's last line is `exec node dist/index.js "$@"`. Stub it
  // with a script that echoes its argv so we can assert CMD flows through.
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
        env: { ...process.env, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: undefined } as NodeJS.ProcessEnv,
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
        env: { ...process.env, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: "" },
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
        env: { ...process.env, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: b64 },
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
        env: { ...process.env, CONNECTOR_KEY_FILE: keyFile, CONNECTOR_KEY_B64: b64 },
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(existsSync(keyFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
