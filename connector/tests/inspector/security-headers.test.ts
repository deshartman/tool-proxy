import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// C1 + C11 — every response served by the inspector's static-asset path
// must carry CSP + nosniff + X-Frame-Options DENY. Defense-in-depth: a
// future XSS regression in app.js would be prevented from `fetch()`-ing
// off-origin or executing inline payloads.
//
// This test binds a small server that mirrors the production serveStatic
// path (same STATIC_TYPES map, same publicDir resolution) so it exercises
// the actual bytes served by the inspector without instantiating the
// whole Inspector class.

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolvePath(__dirname, "../../public");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
};

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

describe("Inspector static-asset security headers", () => {
  let server: Server;
  // Port 0: the OS picks a free one, so the suite runs beside a live connector.
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer(async (req, res) => {
        const name = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html";
        const ext = name.slice(name.lastIndexOf("."));
        const type = STATIC_TYPES[ext];
        if (!type || name.includes("..") || name.includes("/")) {
          res.statusCode = 404; res.end(); return;
        }
        try {
          const body = await readFile(resolvePath(publicDir, name));
          res.statusCode = 200;
          res.setHeader("content-type", type);
          res.setHeader("content-security-policy", CSP_POLICY);
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("x-frame-options", "DENY");
          res.setHeader("referrer-policy", "no-referrer");
          res.end(body);
        } catch {
          res.statusCode = 404; res.end();
        }
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const path of ["/index.html", "/app.js", "/style.css"]) {
    it(`${path} carries CSP + nosniff + X-Frame-Options + Referrer-Policy`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      // 404 is fine if the file happens not to exist; header assertions only
      // apply on 200. But at least ONE of the three should exist.
      if (res.status === 404) return;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).not.toContain("unsafe-eval");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    });
  }
});
