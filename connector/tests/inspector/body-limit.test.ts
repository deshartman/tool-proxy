// Pins the inspector body-size guard: any POST > 64 KiB returns HTTP 413
// with error "payload too large", not 400 "malformed body". The distinction
// matters — operators hitting 400 look for JSON errors; operators hitting
// 413 look for oversized payloads.
//
// Tests via a minimal HTTP server that wires the shared readJsonBody helper
// the same way inspector handlers do (BodyTooLargeError → 413 branch;
// default → 400). Belt-and-braces for the readJsonBody helper AND its
// intended handler-side wiring pattern.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BodyTooLargeError,
  MAX_INSPECTOR_BODY_BYTES,
  readJsonBody,
} from "../../src/inspector/read-body.js";

describe("Inspector body-size guard", () => {
  let server: Server;
  const port = 9092;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const body = await readJsonBody(req);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, size: JSON.stringify(body).length }));
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            res.statusCode = 413;
            res.end("payload too large");
            return;
          }
          res.statusCode = 400;
          res.end("malformed body");
        }
      });
      server.listen(port, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("caps at 64 KiB — well-formed 65 KiB body → HTTP 413", async () => {
    // 65 KiB is one KiB over the cap; safely above 64 * 1024 = 65536 bytes.
    const oversized = { blob: "x".repeat(65 * 1024) };
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oversized),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("payload too large");
  });

  it("well-formed body under the cap → HTTP 200", async () => {
    const smallBody = { mcp: "test", env: { FOO: "bar" } };
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(smallBody),
    });
    expect(res.status).toBe(200);
  });

  it("malformed JSON under the cap → HTTP 400, NOT 413", async () => {
    // A malformed body should still route to the "malformed body" branch, not
    // the payload-too-large branch — operator recovery is different (fix the
    // JSON vs trim the payload).
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("malformed body");
  });

  it("MAX_INSPECTOR_BODY_BYTES is 64 KiB — pinned so a future bump is deliberate", () => {
    expect(MAX_INSPECTOR_BODY_BYTES).toBe(64 * 1024);
  });
});
