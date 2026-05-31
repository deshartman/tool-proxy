// demo-ui — laptop-side process serving the "shim view" UI tab.
//
// DEMO-ONLY. This process listens for INBOUND HTTP connections on the laptop,
// which is the opposite of the architecture's posture (shims are zero-inbound
// in production). It runs only when the user opts in via DEMO_UI_PORT.
//
// Wire shape:
//   shim ── POST /events (NDJSON, one frame per line) ──> demo-ui
//   browser ── GET /events (SSE) ──> demo-ui
// Frames received from shims are republished verbatim to all SSE subscribers.

import "dotenv/config";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { UiEvent, UiPayload, UiTokenEvent } from "@mcp-shim/shared";
import { eventBus } from "./event-bus.js";

const port = Number(process.env.DEMO_UI_PORT ?? process.env.PORT ?? 9000);
const expectedToken = process.env.DEMO_UI_TOKEN;
if (!expectedToken) {
  console.warn(
    "[demo-ui] DEMO_UI_TOKEN unset — accepting unauthenticated POST /events. Set in production demos."
  );
}

// Resolve packages/client/ relative to this file. At runtime __dirname is
// dist/; index.html lives at ../../client/index.html (peer workspace).
const clientDir = resolvePath(__dirname, "../../client");
const clientIndexPath = resolvePath(clientDir, "index.html");

function tokenAuthOk(req: IncomingMessage): boolean {
  if (!expectedToken) return true;
  const raw = req.headers["authorization"];
  if (typeof raw !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (!m) return false;
  const got = m[1];
  if (got.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expectedToken));
}

function isUiEvent(p: unknown): p is UiEvent {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as UiEvent).source === "string" &&
    typeof (p as UiEvent).message === "string" &&
    typeof (p as UiEvent).ts === "number"
  );
}

function isUiTokenEvent(p: unknown): p is UiTokenEvent {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as UiTokenEvent).kind === "token" &&
    typeof (p as UiTokenEvent).queryId === "string"
  );
}

async function handleEventsIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  if (!tokenAuthOk(req)) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", "Bearer");
    res.end("unauthorized");
    return;
  }
  let buffer = "";
  let count = 0;
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (isUiTokenEvent(parsed)) {
          eventBus.publishToken(parsed);
          count++;
        } else if (isUiEvent(parsed)) {
          eventBus.publish(parsed);
          count++;
        }
      } catch {
        // ignore unparseable lines — best-effort ingest
      }
    }
  });
  req.on("end", () => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, accepted: count }));
  });
  req.on("error", () => {
    try {
      res.statusCode = 400;
      res.end();
    } catch {
      /* already ended */
    }
  });
}

function handleEventsStream(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  for (const ev of eventBus.recent()) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  const onPayload = (p: UiPayload) => {
    res.write(`data: ${JSON.stringify(p)}\n\n`);
  };
  eventBus.onPayload(onPayload);
  const cleanup = () => {
    eventBus.offPayload(onPayload);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

async function serveClient(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(clientIndexPath, "utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch (e) {
    res.statusCode = 500;
    res.end(`client UI not found at ${clientIndexPath}: ${(e as Error).message}`);
  }
}

const STATIC_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(res: ServerResponse, name: string): Promise<void> {
  const ext = name.slice(name.lastIndexOf("."));
  const type = STATIC_TYPES[ext];
  if (!type || name.includes("..") || name.includes("/")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  try {
    const body = await readFile(resolvePath(clientDir, name));
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const path = url.pathname;

  if (path === "/events" && req.method === "POST") {
    handleEventsIngest(req, res).catch((e) => {
      console.error("[demo-ui] /events ingest error:", e);
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        /* already ended */
      }
    });
    return;
  }
  if (path === "/events") {
    handleEventsStream(req, res);
    return;
  }
  if (path === "/" || path === "/index.html") {
    // Default the shim view so the laptop tab opens in the right layout.
    if (path === "/" && !url.searchParams.has("view")) {
      res.statusCode = 302;
      res.setHeader("location", "/?view=shim");
      res.end();
      return;
    }
    serveClient(res).catch((e) => {
      console.error("[demo-ui] client error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  if (path === "/app.js") {
    serveStatic(res, "app.js").catch((e) => {
      console.error("[demo-ui] static error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

// Same long-tunnel timing concern as main-server: SSE stays open indefinitely.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(port, () => {
  console.log(`[demo-ui] listening on http://localhost:${port}`);
  if (expectedToken) {
    console.log(`  /events ingest auth: REQUIRED`);
  } else {
    console.warn(`  /events ingest auth: DISABLED — set DEMO_UI_TOKEN`);
  }
  console.log(`  GET  /             — laptop-side UI (auto-redirects to ?view=shim)`);
  console.log(`  POST /events       — shim event ingest (NDJSON)`);
  console.log(`  GET  /events       — SSE stream to browser`);
});
