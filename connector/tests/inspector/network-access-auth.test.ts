import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server, Socket } from "node:net";
import { Inspector, startInspector } from "../../src/inspector/server.js";

// CONNECTOR-NETWORK-EXPOSURE — the request-dispatch gate in server.ts must:
//   - always pass loopback callers through unchanged (today's behavior,
//     forever, regardless of network-access state)
//   - 401 any non-loopback caller on a non-public path without a valid
//     admin session
//   - 401 a non-loopback caller presenting a garbage or wrong-length bearer
//   - let a non-loopback caller with the EXACT correct bearer through
//
// This exercises the real production gate (startInspector/Inspector), not
// a reimplementation of it — mirrors bind-addr-guard.test.ts's preference
// for asserting real socket behavior over source-string matching. Since a
// genuine non-loopback TCP client isn't available in a sandboxed test run,
// the "non-loopback caller" is simulated by patching `remoteAddress` on the
// accepted socket right after connect — the gate reads exactly that field,
// so this exercises the identical code path a real off-box caller would hit.

const NON_LOOPBACK_IP = "203.0.113.5"; // TEST-NET-3 (RFC 5737), never routable

function simulateNonLoopback(server: Server): void {
  server.on("connection", (socket: Socket) => {
    Object.defineProperty(socket, "remoteAddress", { value: NON_LOOPBACK_IP, configurable: true });
  });
}

describe("Network-access request gate (CONNECTOR-NETWORK-EXPOSURE)", () => {
  let httpServer: Server;
  let inspector: Inspector;
  let port: number;

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  describe("loopback caller", () => {
    beforeEach(async () => {
      inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
      httpServer = startInspector(0, inspector);
      await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
      port = (httpServer.address() as { port: number }).port;
    });

    it("reaches the route handler with no Authorization header at all", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`);
      // 404 (no networkAccessRoutes wired in this test) proves the request
      // reached the route dispatch — a 401 from the gate would short-circuit
      // before ever getting there.
      expect(res.status).toBe(404);
    });
  });

  describe("non-loopback caller", () => {
    beforeEach(async () => {
      inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
      httpServer = startInspector(0, inspector);
      simulateNonLoopback(httpServer);
      await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
      port = (httpServer.address() as { port: number }).port;
    });

    it("no Authorization header → 401, never reaches the route handler", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("garbage bearer → 401", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`, {
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.status).toBe(401);
    });

    it("wrong-length bearer → 401", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`, {
        headers: { authorization: "Bearer short" },
      });
      expect(res.status).toBe(401);
    });

    it("exact correct bearer → reaches the route handler", async () => {
      const token = inspector.sessions.mint();
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // 404 (no networkAccessRoutes wired) proves the gate let it through —
      // a 401 would mean the session check itself failed.
      expect(res.status).toBe(404);
    });

    it("public paths (static assets) never require a session", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).not.toBe(401);
    });

    it("/events with the token as a query param (EventSource can't set headers)", async () => {
      const token = inspector.sessions.mint();
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events?token=${token}`, { signal: ac.signal });
      expect(res.status).toBe(200);
      ac.abort();
    });

    it("/events with no token → 401", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/events`);
      expect(res.status).toBe(401);
    });
  });
});
