import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { guardCsrf } from "../../src/inspector/server.js";

describe("CSRF Guard on Inspector POST routes", () => {
  let server: Server;
  // Ephemeral, not fixed. This used to be 9091 — the documented port for a
  // SECOND connector (`scripts/start-connector.sh 9091`) — so the suite failed
  // whenever a dev ran the multi-instance workflow, with requests landing on
  // the live connector's inspector instead of this test server.
  let port: number;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "POST") {
          if (!guardCsrf(req, res)) return;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const postRoutes = [
    "/reconnect",
    "/internal/webhook/revoke",
    "/tool/call",
    "/mcp/reload-creds",
    "/mcp/restart",
    "/mcp/rescan-local",
    "/mcp/session-creds-apply",
    "/mcp/session-creds-clear",
    "/internal/tunnel/creds",
    "/internal/tunnel/force-reregister",
  ];

  for (const route of postRoutes) {
    it(`blocks simple POST request to ${route} without application/json and X-Inspector-Request`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
        },
        body: JSON.stringify({ mcp: "test" }),
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain("CSRF");
    });

    it(`allows POST request to ${route} with application/json and X-Inspector-Request`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-request": "1",
        },
        body: JSON.stringify({ mcp: "test" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  }
});
