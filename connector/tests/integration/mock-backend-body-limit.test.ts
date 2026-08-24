import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// MCP-AUDIT #13 — mock-backend read request bodies with no cap:
//
//   const chunks: Buffer[] = [];
//   for await (const chunk of req) chunks.push(chunk as Buffer);
//
// so a single large POST buffered to OOM. The service has no authentication of
// any kind and relies entirely on Fly private networking, which means anything in
// the same Fly org could do it.
//
// mock-backend is a standalone service outside the npm workspace (its own
// package.json, its own node_modules, no connector imports by design), and its
// entrypoint opens a Postgres pool at module load — so importing server.ts here
// would need a live database. This test therefore exercises the reader shape it
// now uses, against a real socket, rather than the module: the assertion that
// matters is that the read aborts partway instead of buffering to completion, and
// that the write side survives to send the 413.

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

async function readJsonBody(req: NodeJS.ReadableStream & { }): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

let server: Server | undefined;
let port = 0;
let bytesBuffered = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        bytesBuffered = Buffer.byteLength(JSON.stringify(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        // Mirrors server.ts's catch-all: a size rejection must be 413, not the
        // generic 500 internal_error, or the caller cannot tell "too big" from
        // "we broke".
        if (err instanceof BodyTooLargeError) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body_too_large" }));
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    })();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server!.address() as AddressInfo).port;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

describe("mock-backend body limit (MCP-AUDIT #13)", () => {
  it("accepts a normal POST body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", phone: "+15551230000" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an over-cap body with 413 rather than buffering it", async () => {
    bytesBuffered = 0;
    const oversized = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 4096) });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_BODY_BYTES);

    const res = await fetch(`http://127.0.0.1:${port}/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
    // The point of the finding: nothing was retained. The pre-fix reader would
    // have concatenated the whole payload before the handler ever saw it.
    expect(bytesBuffered).toBe(0);
  });

  it("survives the rejection and keeps serving", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Grace" }),
    });
    expect(res.status).toBe(200);
  });
});

// The test above exercises the reader's SHAPE against a real socket. This pins it
// to the actual service: without it, server.ts could revert to the unbounded read
// and every assertion above would still pass.
describe("mock-backend body limit — source trip-wire (MCP-AUDIT #13)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const MOCK = resolve(__dirname, "../../..", "examples/mock-backend");
  const src = readFileSync(join(MOCK, "server.ts"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("server.ts caps the read and throws BodyTooLargeError", () => {
    expect(src).toMatch(/const MAX_BODY_BYTES = 1024 \* 1024;/);
    expect(src).toMatch(/if \(total > MAX_BODY_BYTES\) throw new BodyTooLargeError\(\);/);
  });

  it("server.ts no longer has the unbounded read", () => {
    // The exact pre-fix line: `for await (const chunk of req) chunks.push(...)`
    // with no running total in the loop body.
    expect(src).not.toMatch(/for await \(const chunk of req\) chunks\.push/);
  });

  it("server.ts answers 413, not the generic 500", () => {
    expect(src).toMatch(/BodyTooLargeError/);
    expect(src).toMatch(/send\(res, 413, \{ error: "body_too_large" \}\)/);
  });

  it("both mock-backend logger inits treat an empty LOG_LEVEL as unset", () => {
    // pino throws on an empty level, so `LOG_LEVEL=` in the environment stopped
    // the service booting at all — in two separate files (MCP-AUDIT #21).
    for (const file of ["server.ts", "db.ts"]) {
      const body = readFileSync(join(MOCK, file), "utf8");
      expect(body, `${file} still uses the ?? form`)
        .not.toMatch(/level: process\.env\.LOG_LEVEL \?\?/);
    }
  });
});
