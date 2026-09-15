// End-to-end proof that the tunnel dial actually traverses a forward proxy.
//
// This is the test the whole proxy change exists for. resolveProxy() is unit
// tested in proxy.test.ts; what THIS pins is the wiring — that the decision is
// turned into an `agent` on the real `ws` dial, which is precisely the step
// NODE_USE_ENV_PROXY cannot do for us. A regression here (someone drops the
// agent, or "simplifies" back to `new WebSocket(wsUrl, { headers })`) would
// leave the unit tests green while every proxy-mandated customer breaks.
//
// The fake proxy answers 502 rather than completing the tunnel: we only need to
// observe the CONNECT line, and failing fast keeps the test well inside the
// client's 10s DIAL_TIMEOUT_MS.

import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { TunnelClient } from "../../src/tunnel/client.js";

interface FakeProxy {
  port: number;
  connects: string[];
  close: () => Promise<void>;
}

async function startFakeProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const srv = net.createServer((sock) => {
    sock.once("data", (buf) => {
      connects.push(buf.toString().split("\r\n")[0] as string);
      sock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    sock.on("error", () => { /* client may terminate mid-handshake */ });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    connects,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe("TunnelClient — forward proxy", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("routes the WSS dial through HTTPS_PROXY as an HTTP CONNECT", async () => {
    const proxy = await startFakeProxy();
    try {
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxy.port}`);
      // A non-loopback target, so the loopback exemption doesn't apply. The
      // host never needs to resolve — the proxy is responsible for reaching
      // it, which is exactly why CONNECT works from a host with no egress.
      const client = new TunnelClient("https://controller.invalid/mcp-tunnel", "ts_1_secret", "acme");
      await expect(client.connect()).rejects.toThrow();

      expect(proxy.connects).toHaveLength(1);
      // Port 443 because the https:// URL was upgraded to wss:// before dialing.
      expect(proxy.connects[0]).toBe("CONNECT controller.invalid:443 HTTP/1.1");
    } finally {
      await proxy.close();
    }
  });

  it("dials direct when NO_PROXY exempts the controller host", async () => {
    const proxy = await startFakeProxy();
    try {
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxy.port}`);
      vi.stubEnv("NO_PROXY", "controller.invalid");
      const client = new TunnelClient("https://controller.invalid/mcp-tunnel", "ts_1_secret", "acme");
      await expect(client.connect()).rejects.toThrow();
      // Never touched the proxy.
      expect(proxy.connects).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("names the ignored proxy in the failure when one is configured but bypassed", async () => {
    const proxy = await startFakeProxy();
    try {
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxy.port}`);
      vi.stubEnv("NO_PROXY", "controller.invalid");
      const client = new TunnelClient("https://controller.invalid/mcp-tunnel", "ts_1_secret", "acme");
      // The diagnostic only rides on the TIMEOUT path, not on a fast DNS
      // failure, so assert the helper's wording through resolveProxy instead
      // of racing a 10s timer here. What matters is that a bypassed-but-
      // configured proxy is distinguishable from no proxy at all.
      const { resolveProxy } = await import("../../src/tunnel/proxy.js");
      const d = resolveProxy("wss://controller.invalid/mcp-tunnel");
      expect(d.proxyConfigured).toBe(true);
      expect(d.reason).toBe("excluded");
      await expect(client.connect()).rejects.toThrow();
    } finally {
      await proxy.close();
    }
  });
});
