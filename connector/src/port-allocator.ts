// Child-port allocation shared by every McpSupervisor in the process
// (MULTI-PLATFORM-MCP §5.3).
//
// Each supervisor used to keep its own `reservedPorts` Set and probe with
// canBind at spawn time. Within one supervisor that is safe — the probe's
// result is reserved before the next await. Across TWO supervisors it is not:
// both can probe the same free port before either reserves it, and the second
// child then fails EADDRINUSE at listen. One workspace per tunnel means one
// supervisor per tunnel, so the allocator has to be shared.
//
// reserve() therefore runs probe-then-reserve inside a promise-chain mutex (the
// same shape as ConfigStore.mutate), so the pair is atomic across every caller.
// The probe host stays 127.0.0.1 — it must match LOOPBACK_BIND, the address the
// child actually binds (CLAUDE.md: "the pre-spawn port probe must test the same
// host the child binds").

import { createServer } from "node:net";

export type PortProbe = (port: number) => Promise<boolean>;

export class PortAllocator {
  private readonly reserved = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly probe: PortProbe = canBindLoopback, private readonly span = 1000) {}

  /** Reserve the first free port at or above `from`. Atomic across callers. */
  reserve(from: number): Promise<number> {
    const run = this.queue.then(async () => {
      for (let port = from; port < from + this.span; port++) {
        if (this.reserved.has(port)) continue;
        if (await this.probe(port)) {
          this.reserved.add(port);
          return port;
        }
      }
      throw new Error(`no free port found above ${from}`);
    });
    // Keep the chain alive after a rejection so one exhausted range can't wedge
    // every later reservation. The caller still sees its own rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  release(port: number): void {
    this.reserved.delete(port);
  }

  isReserved(port: number): boolean {
    return this.reserved.has(port);
  }
}

// Pre-spawn port probe. The host here MUST match the host the child actually
// binds — sdk/http-server.ts's LOOPBACK_BIND (MCP-AUDIT #14). It didn't before
// #1: the probe tested 127.0.0.1 while the child bound all interfaces, so a
// process holding 192.168.x.x:7100 left the probe reporting free and the child
// then failed EADDRINUSE at listen. Widening either side alone reopens that gap.
export function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
