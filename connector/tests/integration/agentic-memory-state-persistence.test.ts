import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, statSync, existsSync, mkdirSync, chmodSync, readdirSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

// MCP-AUDIT #3 + #30 — the agentic-memory mock's state file.
//
// #3: the file resolved relative to its own module, i.e.
// /app/bundled-mcps/agentic-memory/.state.json in the image. `chown -R mcp:mcp
// /app` runs BEFORE the COPY lines and COPY defaults to 0:0, so that tree ships
// root-owned while the process runs as mcp — every mutating tool failed EACCES
// in production and passed in dev, where the developer owns the tree. saveState
// had no error handling and all ten call sites used bare store.commit().
//
// The fix relocates the file to /var/lib/tool-proxy (writable, chowned, and
// the volume mount point in every deploy target) rather than making /app
// writable. Root-owned code is the STRONGER posture: children run as the same
// uid as the connector, so a writable /app would let a compromised child rewrite
// the connector's dist/ or a sibling MCP's tools and persist across a restart.
// The audit's original advice — "--chown=mcp:mcp on the COPY lines regardless" —
// was wrong; the trip-wire at the bottom now pins the opposite.
//
// #30: the write is 0600. The default was `0666 & ~umask` = 0644 under Alpine's
// default 022 (measured), and the contents are PII — conversation summaries,
// channel aliases, hydrated customer data.
//
// TEST SHAPE: state.ts builds its singleton Store at module load, so the env var
// must be set before the first import — hence the deferred dynamic import in
// beforeAll, matching agentic-memory-smoke.test.ts. Cases needing distinct paths
// drive the exported saveState() directly instead of re-importing the module: a
// `?t=` cache-buster makes vite parse the file as JS and choke on its inline
// `type` import, which is how the first version of this test failed.

const DROPIN_DIR = resolve(__dirname, "../../..", "bundled-mcps/agentic-memory");
const ROOT = resolve(__dirname, "../../..");

// chmod-based read-only cases are meaningless as root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

type StateMod = {
  store: { state: Record<string, unknown>; path: string; commit(): void };
  commitOrError: () => { isError: true; content: Array<{ type: string; text: string }> } | undefined;
  saveState: (p: string, s: unknown) => void;
  emptyState: () => Record<string, unknown>;
};

let mod: StateMod;
let singletonDir: string;

beforeAll(async () => {
  singletonDir = mkdtempSync(join(tmpdir(), "am-singleton-"));
  process.env.AGENTIC_MEMORY_STATE_PATH = join(singletonDir, "nested", ".state.json");
  mod = (await import(`${DROPIN_DIR}/state.ts`)) as StateMod;
});

afterAll(() => rmSync(singletonDir, { recursive: true, force: true }));

// Fresh scratch dir for the saveState() cases.
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "am-state-")); });
afterEach(() => {
  try { chmodSync(tmp, 0o700); } catch { /* may not exist */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("MCP-AUDIT #3 — saveState writes to a path it may have to create", () => {
  it("creates a missing parent directory on first write", () => {
    // Mirrors production: /var/lib/tool-proxy exists, the agentic-memory/
    // leaf does not until we make it.
    const statePath = join(tmp, "agentic-memory", ".state.json");
    expect(existsSync(dirname(statePath))).toBe(false);
    mod.saveState(statePath, mod.emptyState());
    expect(existsSync(statePath)).toBe(true);
  });

  it("round-trips state through the file", () => {
    const statePath = join(tmp, ".state.json");
    const state = { ...mod.emptyState(), identities: { abc123: { externalId: "abc123", aliases: [], createdAt: "t" } } };
    mod.saveState(statePath, state);
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { identities: Record<string, unknown> };
    expect(onDisk.identities.abc123).toBeDefined();
  });

  it("leaves no .tmp file behind on a successful write", () => {
    const statePath = join(tmp, ".state.json");
    mod.saveState(statePath, mod.emptyState());
    expect(readdirSync(tmp)).toEqual([".state.json"]);
  });
});

describe("MCP-AUDIT #30 — the state file is not world-readable", () => {
  it("writes the state file 0600", () => {
    const statePath = join(tmp, ".state.json");
    mod.saveState(statePath, mod.emptyState());
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("keeps 0600 when rewriting over a file left at 0644 by an older build", () => {
    // rename carries the tmp inode's mode, but a pre-existing target can retain
    // its own on some platforms — hence the explicit chmod after rename.
    const statePath = join(tmp, ".state.json");
    mod.saveState(statePath, mod.emptyState());
    chmodSync(statePath, 0o644);
    mod.saveState(statePath, mod.emptyState());
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });
});

describe("MCP-AUDIT #3 — commitOrError turns a write failure into a diagnosable result", () => {
  it("returns undefined on success and creates the singleton's nested dir", () => {
    expect(mod.commitOrError()).toBeUndefined();
    expect(existsSync(mod.store.path)).toBe(true);
    expect(statSync(mod.store.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isRoot)("returns a structured storage_full envelope when the directory is unwritable", () => {
    const dir = dirname(mod.store.path);
    mkdirSync(dir, { recursive: true });
    mod.commitOrError();              // ensure the file exists while writable
    chmodSync(dir, 0o500);            // no create, no rename
    try {
      mod.store.state.identities = { probe: { externalId: "probe", aliases: [], createdAt: "now" } };
      const failed = mod.commitOrError();

      // The point of the fix: a diagnosable envelope, not an opaque throw.
      expect(failed).toBeDefined();
      expect(failed?.isError).toBe(true);
      const payload = JSON.parse(failed!.content[0].text) as {
        error: { code: string; retryable: boolean; message: string };
      };
      expect(payload.error.code).toBe("storage_full");
      expect(payload.error.retryable).toBe(true);
      expect(payload.error.message).toMatch(/could not persist memory state/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("MCP-AUDIT #3 — trip-wires", () => {
  it("no tool file calls store.commit() directly", () => {
    const toolsDir = join(DROPIN_DIR, "tools");
    const offenders: string[] = [];
    for (const f of readdirSync(toolsDir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(toolsDir, f), "utf8");
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      if (/\bstore\.commit\(\)/.test(code)) offenders.push(f);
    }
    expect(offenders, "these tools must use commitOrError() so a write failure is diagnosable").toEqual([]);
  });

  it("every tool that persists imports commitOrError", () => {
    const toolsDir = join(DROPIN_DIR, "tools");
    const missing: string[] = [];
    for (const f of readdirSync(toolsDir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(toolsDir, f), "utf8");
      if (!src.includes("commitOrError()")) continue;
      if (!/import \{[^}]*\bcommitOrError\b[^}]*\} from "\.\.\/state\.js";/.test(src)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it("the Dockerfile points state at the writable volume and does NOT chown the code tree", () => {
    const dockerfile = readFileSync(join(ROOT, "connector/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/ENV AGENTIC_MEMORY_STATE_PATH=\/var\/lib\/tool-proxy\//);
    // Root-owned code is deliberate — see the Dockerfile's ownership note.
    const copyLines = dockerfile.split("\n").filter((l) => l.startsWith("COPY --from=node-build"));
    expect(copyLines.length).toBeGreaterThan(0);
    for (const line of copyLines) expect(line).not.toContain("--chown");
  });
});
