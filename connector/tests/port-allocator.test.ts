import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { PortAllocator, canBindLoopback, type PortProbe } from "../src/port-allocator.js";

// MULTI-PLATFORM-MCP §5.3. One workspace per tunnel means one McpSupervisor
// per tunnel, all spawning children from the same MCP_BASE_PORT range. Each
// supervisor used to keep its own reservation set and probe at spawn time, so
// two of them could probe the same free port before either reserved it — and
// the second child failed EADDRINUSE at listen. A shared allocator serialises
// probe-then-reserve. These tests reproduce the race deterministically with a
// probe that yields, the way a real bind probe does.

// Every port reads as free, but the answer arrives on a later tick — which is
// exactly the window two independent callers race through.
const slowAlwaysFree: PortProbe = () => new Promise((r) => setImmediate(() => r(true)));

describe("PortAllocator", () => {
  it("gives concurrent callers on ONE shared allocator distinct ports", async () => {
    const shared = new PortAllocator(slowAlwaysFree);
    const ports = await Promise.all([shared.reserve(7100), shared.reserve(7100), shared.reserve(7100)]);
    expect(new Set(ports).size).toBe(3);
    expect(ports.sort()).toEqual([7100, 7101, 7102]);
  });

  it("demonstrates the race it fixes: two PRIVATE allocators collide", async () => {
    // The pre-fix shape — one reservation set per supervisor. Both probe 7100
    // as free and both take it. This is why supervisors must share one.
    const a = new PortAllocator(slowAlwaysFree);
    const b = new PortAllocator(slowAlwaysFree);
    const [pa, pb] = await Promise.all([a.reserve(7100), b.reserve(7100)]);
    expect(pa).toBe(pb);
  });

  it("reuses a port once it is released", async () => {
    const alloc = new PortAllocator(slowAlwaysFree);
    const first = await alloc.reserve(7100);
    alloc.release(first);
    expect(await alloc.reserve(7100)).toBe(first);
  });

  it("skips a port the probe reports as taken", async () => {
    const alloc = new PortAllocator(async (port) => port !== 7100);
    expect(await alloc.reserve(7100)).toBe(7101);
  });

  it("rejects when the range is exhausted, without wedging later calls", async () => {
    const alloc = new PortAllocator(async () => false, 3);
    await expect(alloc.reserve(7100)).rejects.toThrow(/no free port found above 7100/);
    // The mutex chain must survive the rejection.
    const ok = new PortAllocator(slowAlwaysFree, 3);
    await expect(ok.reserve(7100)).resolves.toBe(7100);
    await expect(alloc.reserve(7100)).rejects.toThrow();
  });

  it("probes loopback for real: skips a port another process holds on 127.0.0.1", async () => {
    const holder: Server = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const held = (holder.address() as { port: number }).port;
    try {
      expect(await canBindLoopback(held)).toBe(false);
      const alloc = new PortAllocator();
      const got = await alloc.reserve(held);
      expect(got).not.toBe(held);
      alloc.release(got);
    } finally {
      holder.close();
    }
  });
});
