import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server, Socket } from "node:net";
import { Inspector, startInspector } from "../../src/inspector/server.js";

// CONNECTOR-NETWORK-EXPOSURE — the request-dispatch gate in server.ts must:
//   - always pass loopback callers through unchanged, for every route
//     (today's behavior, forever, regardless of network-access state —
//     there is no admin login, this dashboard is loopback-only period)
//   - let a non-loopback caller reach ONLY /oauth/token
//   - 403 a non-loopback caller on every other path, unconditionally —
//     no header, no token, no opt-in changes that
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

    it("reaches the route handler for the dashboard and internal routes with no header at all", async () => {
      const dashboard = await fetch(`http://127.0.0.1:${port}/`);
      expect(dashboard.status).toBe(200);

      const status = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`);
      // 404 (no networkAccessRoutes wired in this test) proves the request
      // reached the route dispatch — a 403 from the gate would short-circuit
      // before ever getting there.
      expect(status.status).toBe(404);
    });

    it("/events connects with no token/header at all", async () => {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      ac.abort();
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

    it("the dashboard is unreachable — 403, no exceptions, no login flow", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(403);
    });

    it("static assets are unreachable — 403", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/app.js`);
      expect(res.status).toBe(403);
    });

    it("/events is unreachable — 403", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/events`);
      expect(res.status).toBe(403);
    });

    it("API-client management is unreachable — 403 (operator-only, loopback-gated)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`);
      expect(res.status).toBe(403);
    });

    it("even a well-formed bearer header doesn't help — there is no session concept anymore", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`, {
        headers: { authorization: "Bearer anything-at-all" },
      });
      expect(res.status).toBe(403);
    });

    it("/oauth/token is the one path that reaches the route dispatch", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST" });
      // 404 (no oauthTokenHandler wired in this test) proves the gate let it
      // through — a 403 would mean the allowlist check itself failed.
      expect(res.status).toBe(404);
    });
  });
});
