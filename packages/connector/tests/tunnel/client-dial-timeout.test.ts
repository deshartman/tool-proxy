import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { TunnelClient } from "../../src/tunnel/client.js";

// Pins the regression observed 2026-06-20 in /tmp/connector-boot.log:
// a WebSocket dial against a half-open TCP socket hung for ~4 minutes
// before the OS fired ECONNRESET. During that window the connector sat
// in `reconnecting=true` and the manual Reconnect button silently
// dropped operator clicks. The hard cap on the dial below is what
// keeps the connector responsive — without it, the symptom stack
// (stuck reconnecting, dead button, no log lines) reappears.
//
// We test by standing up an HTTP server that accepts TCP but never
// answers the upgrade. The TunnelClient should reject within the
// dial-timeout window, not hang for the kernel TCP timeout.

const ALLOW_ABOVE_DEFAULT_DIAL_MS = 12_000; // dial timeout is 10s; give a small margin

describe("TunnelClient — dial timeout", () => {
  let server: Server | undefined;

  afterEach(() => {
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it("rejects with a 'timed out' error rather than hanging when the upgrade never completes", async () => {
    // Server accepts the TCP / TLS handshake at the socket layer, but
    // never responds to the HTTP/1.1 Upgrade request the WebSocket
    // client sends. We hold the request open by NOT calling res.end()
    // and NOT writing the upgrade response — the dial sits there until
    // our timeout fires.
    server = createServer(() => {
      // Intentionally empty — never reply. Mimics a dead controller
      // that's still LISTENing but isn't answering.
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    const client = new TunnelClient(url, "test-token", "test-connector");
    const startedAt = performance.now();
    let caught: Error | undefined;
    try {
      await client.connect();
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    const elapsed = performance.now() - startedAt;

    expect(caught).toBeDefined();
    // Error message names the timeout. If a future change drops the
    // dial-timeout but keeps the rejection (e.g. via an outer
    // AbortSignal), the surface still passes — we want the *cause*.
    expect(caught?.message ?? "").toMatch(/dial timed out/i);
    // The whole point: this must come back fast. Anything north of
    // ~11–12s means the dial-timeout regressed.
    expect(elapsed).toBeLessThan(ALLOW_ABOVE_DEFAULT_DIAL_MS);
  }, 30_000); // generous test budget; the actual rejection should be <12s
});
