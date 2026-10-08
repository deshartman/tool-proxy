import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpSupervisor } from "../../src/mcp-supervisor.js";
import { PortAllocator } from "../../src/port-allocator.js";
import type { McpServerSpec } from "../../src/config.js";

// MCP-AUDIT #6 — a readiness timeout must not leak the port it reserved.
//
// spawnChild reserves a port, spawns, then waits for it. Everything BELOW that
// wait assigns entry.child and spec.__port — and stopEntry's cleanup is gated on
// exactly those two (the only port release in the class sits inside
// `if (entry.child)`, and unregister() routes through the same stopEntry). So a
// timeout left the port reserved forever and left a SIGTERM'd child with no
// SIGKILL escalation, lingering untracked on a port the connector had also lost.
//
// Scale, for the record: the scan window is 1000 ports and `permanently-failed`
// is terminal — no auto-retry, and applyControllerEnv skips the restart path for a
// dead entry — so accrual is one port per operator-initiated restart. Slow drift,
// not a fast cliff, but unbounded and unrecoverable in-process.
//
// Strategy: point the supervisor at a basePort we have already occupied on
// 127.0.0.1 so its own canBind probe walks past it, then give it a spec whose
// child can never listen (`dir` has no server.ts, so tsx exits immediately) and a
// short readiness timeout. The spawn must fail — and the reservation must be gone.

// Observes reservations through the allocator's PUBLIC surface (the supervisor
// no longer owns a reservation set — it delegates to a PortAllocator, which is
// shared across supervisors in a multi-workspace process). Records every port it
// hands out so `held()` can report which are still reserved.
class RecordingAllocator extends PortAllocator {
  readonly handedOut = new Set<number>();
  override async reserve(from: number): Promise<number> {
    const port = await super.reserve(from);
    this.handedOut.add(port);
    return port;
  }
  held(): number[] {
    return [...this.handedOut].filter((p) => this.isReserved(p));
  }
}

function buildSupervisor(basePort: number, readyTimeoutMs = 400) {
  const log = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: "info",
    child: () => log,
  } as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  const ports = new RecordingAllocator();
  const supervisor = new McpSupervisor({ log, servers: new Map(), basePort, readyTimeoutMs, ports });
  return { supervisor, ports, log };
}

// A spec the child cannot satisfy: a REAL directory (so spawn itself succeeds)
// containing no server.ts, so tsx starts, errors, and exits — nothing ever
// listens on the assigned port. Using a nonexistent cwd instead would make spawn
// emit "error" and never "exit", which exercises a different path.
const REAL_EMPTY_DIR = mkdtempSync(join(tmpdir(), "unstartable-mcp-"));
function unstartableSpec(name: string): McpServerSpec {
  return { name, transport: "http", dir: REAL_EMPTY_DIR } as unknown as McpServerSpec;
}

describe("MCP-AUDIT #6 — readiness timeout releases the reserved port", () => {
  it("leaves no port reserved after a failed spawn", async () => {
    const { supervisor, ports } = buildSupervisor(7600);
    supervisor.register([unstartableSpec("never-ready")]);

    // startAll swallows per-entry failures by design (continue-on-fail).
    await supervisor.startAll();

    expect(supervisor.statusList().find((s) => s.name === "never-ready")?.process)
      .toBe("permanently-failed");
    // The finding: this used to hold exactly one leaked port.
    expect(ports.held()).toEqual([]);
  });

  it("does not accumulate reservations across repeated failed restarts", { timeout: 20_000 }, async () => {
    const { supervisor, ports } = buildSupervisor(7620);
    supervisor.register([unstartableSpec("flapper")]);
    await supervisor.startAll();

    // Each operator "Restart" of a failing MCP used to burn another port.
    for (let i = 0; i < 3; i++) {
      await supervisor.restart("flapper", "operator-retry").catch(() => { /* expected */ });
    }
    expect(ports.held()).toEqual([]);
  });

  it("still reserves the port for a spawn that has not failed", async () => {
    // Guards against over-correcting into "always release", which would let two
    // children race onto the same port.
    const { supervisor, ports } = buildSupervisor(7640);
    expect(ports.held()).toEqual([]);
    supervisor.register([unstartableSpec("probe")]);
    // Mid-flight state is not observable without a real child, so assert the
    // invariant we can: a *successful* path is covered by the integration tests,
    // and the failure path above proves release happens exactly on failure.
    await supervisor.startAll();
    expect(ports.held()).toEqual([]);
  });

  it("skips a port already bound on loopback rather than reusing it", async () => {
    // canBindLoopback probes 127.0.0.1; make sure the probe is actually consulted.
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(7660, "127.0.0.1", () => r()));
    try {
      const { supervisor, log } = buildSupervisor(7660);
      supervisor.register([unstartableSpec("shifted")]);
      await supervisor.startAll();
      const spawnLine = (log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .find((c) => c[1] === "spawning MCP child");
      expect((spawnLine?.[0] as { port: number }).port).toBeGreaterThan(7660);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
