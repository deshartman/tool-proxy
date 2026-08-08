import { describe, it, expect } from "vitest";
import os from "node:os";
import { Inspector, startInspector, rebindInspector } from "../../src/inspector/server.js";
import { createLogger } from "../../src/logger.js";

// CONNECTOR-NETWORK-EXPOSURE — "Enable network access" must live-rebind the
// SAME http.Server instance from loopback-only to reachable-from-elsewhere,
// with no process restart and no server recreation, while loopback access
// keeps working throughout (the permanent recovery path never regresses).
//
// A genuine non-loopback client is simulated by connecting via the host's
// own real network interface address rather than 127.0.0.1 — before the
// rebind that address isn't bound at all (ECONNREFUSED); after, it is.

function firstNonLoopbackIPv4(): string | undefined {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

const externalAddr = firstNonLoopbackIPv4();

describe.skipIf(!externalAddr)("Live network-access rebind (CONNECTOR-NETWORK-EXPOSURE)", () => {
  it("rebinds loopback -> reachable, in-process, without restarting; loopback keeps working throughout", async () => {
    const log = createLogger("test-network-access-enable");
    const inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
    const httpServer = startInspector(0, inspector);
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
    const port = (httpServer.address() as { port: number }).port;

    // Before "enable": bound to 127.0.0.1 only.
    await expect(
      fetch(`http://${externalAddr}:${port}/`, { signal: AbortSignal.timeout(1500) })
    ).rejects.toThrow();
    const beforeLoopback = await fetch(`http://127.0.0.1:${port}/`);
    expect(beforeLoopback.status).toBe(200);

    // "Enable network access" — live rebind. Same Server object throughout;
    // no restart, no re-registering routes.
    rebindInspector(httpServer, port, log);
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));

    // After: reachable via the external interface AND still via loopback.
    const afterExternal = await fetch(`http://${externalAddr}:${port}/`);
    expect(afterExternal.status).toBe(200);
    const afterLoopback = await fetch(`http://127.0.0.1:${port}/`);
    expect(afterLoopback.status).toBe(200);

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("re-invoking rebind while already wide-bound is a no-op (idempotent)", async () => {
    const log = createLogger("test-network-access-enable");
    const inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
    const httpServer = startInspector(0, inspector);
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
    const port = (httpServer.address() as { port: number }).port;

    rebindInspector(httpServer, port, log);
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
    expect((httpServer.address() as { address: string }).address).toBe("0.0.0.0");

    // Second call should not throw and should not tear down the listener.
    expect(() => rebindInspector(httpServer, port, log)).not.toThrow();
    const stillUp = await fetch(`http://127.0.0.1:${port}/`);
    expect(stillUp.status).toBe(200);

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
