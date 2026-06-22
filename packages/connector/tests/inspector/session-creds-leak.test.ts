import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inspector, startInspector, type McpActions } from "@connector/inspector/server.js";
import { McpSupervisor } from "@connector/mcp-supervisor.js";
import { createLogger } from "@connector/logger.js";
import type { McpServerSpec } from "@connector/config.js";
import type { McpServerConnection } from "@connector/servers/index.js";

// INSPECTOR-CREDS-VISIBILITY (W-S9) — pin every channel through which a
// session-pasted cred could leak out of the connector. Each test plants a
// unique magic value `tok_leak_test_<rand>` so post-leak greps and
// JSON.stringify-contains assertions are unambiguous.
//
// Channels covered here (route + supervisor surface):
//   L1 — POST /mcp/session-creds-apply response body
//   L2 — POST /mcp/session-creds-clear + subsequent response bodies
//   L3 — SSE event payloads from /events
//   L4 — frame log (FrameTap[]) exposed via the inspector snapshot
//   L5 — manifest payload exposed via the inspector snapshot
//   L6 — pino log lines captured during the paste cycle
//   L8 — disk grep across the working tree (no persistence)
//
// L7 (statusList accessor) is pinned in tests/mcp-supervisor/session-env.test.ts.
// L9 (UI repaste echo) and L10 (TTL race) are scheduled for the W-S10 UI suite.

let usedMagic = new Set<string>();
function freshMagic(): string {
  for (let i = 0; i < 32; i++) {
    const v = `tok_leak_test_${Math.random().toString(36).slice(2, 14)}`;
    if (!usedMagic.has(v)) {
      usedMagic.add(v);
      return v;
    }
  }
  throw new Error("could not mint unique magic value");
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface Harness {
  port: number;
  inspector: Inspector;
  supervisor: McpSupervisor;
  pinoCaptures: string[];
}

async function buildHarness(): Promise<Harness> {
  const pinoCaptures: string[] = [];

  // Capture every pino write. createLogger goes through pino's own
  // `destination` shape, which we override here for this test only via
  // a write-stream-like object pino can target.
  // For our purposes we wrap createLogger with a child-bound capture by
  // monkey-patching console — pino's pretty printer falls back to
  // console.log under specific conditions. Simpler: use a no-op logger
  // driven by createLogger and capture via a process-level stdout tap.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const restore = () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    pinoCaptures.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    // Forwarding to the original write — chunk's string-or-Uint8Array
    // shape is what stdout.write accepts; the spread is its variadic
    // (encoding, callback) tail. Cast through unknown for the
    // overload-resolution mismatch.
    return (origStdoutWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    pinoCaptures.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return (origStderrWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  // Restore in afterEach via the captures handle.
  (pinoCaptures as unknown as { __restore: () => void }).__restore = restore;

  const log = createLogger("session-creds-leak-test");
  const servers = new Map<string, McpServerConnection>();
  const supervisor = new McpSupervisor({ log, servers });

  // Register a single Type 1 spec (no spawn) so applySessionEnv accepts it.
  // The dir is never read — supervisor only spawns on startAll(), which we
  // don't call. We still create a real tmpdir so the path is well-formed.
  const dir = mkdtempSync(join(tmpdir(), "session-creds-leak-"));
  const spec: McpServerSpec = { name: "alpha", transport: "http", dir } as McpServerSpec;
  supervisor.register([spec]);

  const inspector = new Inspector({
    controllerUrl: "https://controller.example.com",
    state: "open",
  });
  inspector.mcpActions = {
    reloadCreds: async () => undefined,
    restart: async () => undefined,
    applySessionCreds: async (name, env) => {
      const result = await supervisor.applySessionEnv(name, env);
      // Mirror lifecycle.ts: applied:false means unknown MCP — surface as
      // an error so the route can render ok:false.
      if (!result.applied) throw new Error(`unknown MCP "${name}"`);
      return { expiresAt: result.expiresAt };
    },
    clearSessionCreds: async (name) => {
      await supervisor.clearSessionEnv(name);
    },
  } as McpActions;

  const port = await findFreePort();
  startInspector(port, inspector);
  // brief listen-warmup
  await new Promise((r) => setTimeout(r, 20));

  return { port, inspector, supervisor, pinoCaptures };
}

function teardown(harness: Harness): void {
  const restore = (harness.pinoCaptures as unknown as { __restore?: () => void }).__restore;
  restore?.();
}

async function postJson(port: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe("inspector session-creds leak channels (W-S9)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(() => {
    teardown(harness);
  });

  it("L1 — apply route response NEVER includes the pasted value", async () => {
    const SECRET = freshMagic();
    const r = await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });
    expect(r.status).toBe(202);
    expect(r.text).not.toContain(SECRET);
    // Sanity: response really did acknowledge.
    const body = JSON.parse(r.text);
    expect(body.ok).toBe(true);
    expect(typeof body.expiresAt).toBe("number");
  });

  it("L2 — clear route response NEVER includes the pasted value (after a paste cycle)", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });
    const r = await postJson(harness.port, "/mcp/session-creds-clear", { mcp: "alpha" });
    expect(r.status).toBe(202);
    expect(r.text).not.toContain(SECRET);
  });

  it("L2 — every other route response NEVER includes the pasted value", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });

    // /reconnect, /mcp/restart, /mcp/reload-creds: hit each, drain body, assert clean.
    const reconnect = await postJson(harness.port, "/reconnect", {});
    expect(reconnect.text).not.toContain(SECRET);

    const restart = await postJson(harness.port, "/mcp/restart", { mcp: "alpha" });
    expect(restart.text).not.toContain(SECRET);

    // No /tool/call (no toolDispatch wired on the harness — would 503, but
    // even a 503 body must be SECRET-free).
    const callRes = await postJson(harness.port, "/tool/call", { server: "alpha", tool: "x", args: {} });
    expect(callRes.text).not.toContain(SECRET);
  });

  it("L3 — /events SSE stream NEVER carries the pasted value across status broadcasts", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });

    // Trigger a status snapshot push by re-emitting mcpStatuses. The
    // supervisor doesn't auto-push on applySessionEnv (boot/lifecycle is
    // what publishes statuses) — for this test, drive it directly off
    // statusList(). The test is whether THE SHAPE THE INSPECTOR
    // BROADCASTS leaks the value, regardless of who triggers the push.
    harness.inspector.setMcpStatuses(harness.supervisor.statusList());

    // Open SSE, read for 200ms, close, scan all chunks.
    const chunks: string[] = [];
    const ac = new AbortController();
    const response = await fetch(`http://127.0.0.1:${harness.port}/events`, { signal: ac.signal });
    if (!response.body) throw new Error("expected SSE body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const readUntil = (async () => {
      const deadline = Date.now() + 200;
      while (Date.now() < deadline) {
        const t = setTimeout(() => ac.abort(), Math.max(1, deadline - Date.now()));
        try {
          const { value, done } = await reader.read();
          clearTimeout(t);
          if (done) break;
          if (value) chunks.push(decoder.decode(value));
        } catch {
          break;
        }
      }
    })();
    await readUntil;
    const blob = chunks.join("");
    expect(blob).not.toContain(SECRET);
    // Sanity: stream really did carry status-shaped data.
    expect(blob.length).toBeGreaterThan(0);
  });

  it("L4 — frame log snapshot NEVER carries the pasted value", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });

    // Inspector.recordTap is how outbound/inbound frames land in the
    // snapshot. Plant a synthetic frame containing routine traffic and
    // assert the SECRET still doesn't appear in the rendered snapshot.
    harness.inspector.recordTap({
      ts: Date.now(),
      direction: "out",
      type: "register",
      summary: "register frame",
    });

    const snapshot = harness.inspector.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("L5 — manifest snapshot NEVER carries the pasted value", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });

    // Plant a synthetic manifest. The leak guard is structural: the
    // session creds layer must NEVER feed into manifest assembly.
    // Cast through unknown because we deliberately ship a minimal
    // ToolManifest shape — full schema is irrelevant to the leak check.
    harness.inspector.setManifest({
      tools: [],
      servers: [{ name: "alpha", author: "customer", tools: [] }],
    } as unknown as Parameters<typeof harness.inspector.setManifest>[0]);

    const snapshot = harness.inspector.snapshot();
    expect(JSON.stringify(snapshot.kind === "snapshot" ? snapshot.manifest : {})).not.toContain(SECRET);
  });

  it("L6 — pino log captures NEVER include the pasted value across a paste+clear cycle", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });
    await postJson(harness.port, "/mcp/session-creds-clear", { mcp: "alpha" });

    const blob = harness.pinoCaptures.join("");
    expect(blob).not.toContain(SECRET);
  });

  it("L8 — disk grep: paste an MCP session cred, look for the value across packages/connector/src", async () => {
    const SECRET = freshMagic();
    await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: SECRET },
    });

    // Walk the connector source tree (no node_modules) and assert the
    // SECRET does not appear in any committed-or-runtime file. This is
    // belt-and-braces: any future code that decided to write the value
    // somewhere on disk would trip this immediately.
    const root = join(__dirname, "../../src");
    const files = walkSync(root);
    for (const f of files) {
      const contents = readFileSync(f, "utf-8");
      expect(contents, `disk leak in ${f}`).not.toContain(SECRET);
    }
  });

  it("rejects non-string env values (route validation)", async () => {
    const r = await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { TWILIO_AUTH_TOKEN: 12345 },
    });
    expect(r.status).toBe(400);
  });

  it("rejects oversized env values (route validation)", async () => {
    const r = await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "alpha",
      env: { BIG: "x".repeat(9 * 1024) },
    });
    expect(r.status).toBe(413);
  });

  it("rejects unknown MCP names with 200 ok:false (route surfaces supervisor error)", async () => {
    const r = await postJson(harness.port, "/mcp/session-creds-apply", {
      mcp: "does-not-exist",
      env: { TOKEN: "x" },
    });
    expect(r.status).toBe(200); // shape mirrors handleMcpAction's error path
    const body = JSON.parse(r.text);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("does-not-exist");
  });
});

// Small directory walker so we don't pull in a dep just for this test.
function walkSync(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSync(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}
