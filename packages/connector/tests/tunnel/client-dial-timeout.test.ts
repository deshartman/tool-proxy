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

  // Pins the regression observed 2026-07-20: when the controller was down,
  // Node's happy-eyeballs dial (dual-stack IPv4+IPv6) emitted an
  // AggregateError with ECONNREFUSED sub-errors. The ws library had already
  // transitioned readyState from CONNECTING to CLOSING before firing 'error',
  // so the old `readyState === CONNECTING` check misclassified it as
  // post-open and routed it to `this.onerror` — producing an ERROR-level
  // log with a full stack trace, followed a millisecond later by the WARN
  // about auto-reconnect that had already handled the same failure.
  //
  // The fix keys the pre-vs-post distinction off a per-Promise `settled`
  // flag inside client.ts. This test locks it in: connect() must reject
  // with the underlying dial error, and onerror must NOT be called.
  it("rejects with the underlying dial error (does NOT escape to onerror) when TCP is refused", async () => {
    // Get a definitely-closed port by binding then releasing it. Racy on
    // paper (the OS could re-hand the port to a different test), but fine
    // in practice for a localhost port picked microseconds ago.
    const tmp = createServer();
    await new Promise<void>((resolve) => {
      tmp.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = tmp.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      tmp.close(() => resolve());
    });

    const url = `http://127.0.0.1:${port}`;
    const client = new TunnelClient(url, "test-token", "test-connector");
    const onerrorCalls: Error[] = [];
    client.onerror = (err) => {
      onerrorCalls.push(err);
    };

    let caught: Error | undefined;
    try {
      await client.connect();
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBeDefined();
    // Load-bearing: pre-open dial failures must REJECT the connect Promise,
    // NOT fire onerror. If a future refactor reintroduces a readyState-based
    // check, onerror will fire an ERROR-level log with a full stack and the
    // regression is back. The `settled` flag in client.ts is the guard.
    expect(onerrorCalls).toEqual([]);
  }, 10_000);

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
