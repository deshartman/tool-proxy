import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { WebSocketServer } from "ws";
import { registry } from "./registry.js";
import { acceptTunnel } from "./tunnel-server.js";
import { eventBus, logInfo } from "./event-bus.js";
import { callTool } from "./rpc-bridge.js";
import type { UiEvent } from "./types.js";

const port = Number(process.env.PORT ?? 9090);

// __dirname is dist/ at runtime (CommonJS); static UI is at ../public/.
const publicDir = resolvePath(__dirname, "../public");

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const send = (e: UiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  // Replay current state so a fresh tab catches up.
  send({ kind: "registry", connectors: registry.list() });
  for (const log of eventBus.recentLogs()) send(log);

  const unsubscribe = eventBus.subscribe(send);
  const cleanup = () => {
    unsubscribe();
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

async function handleCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST required" }));
    return;
  }
  const body = (await readJsonBody(req)) as {
    connectorId?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  };
  if (!body.connectorId || !body.tool) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "connectorId and tool required" }));
    return;
  }
  const result = await callTool(body.connectorId, body.tool, body.arguments);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(result, null, 2));
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
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
    const body = await readFile(resolvePath(publicDir, name));
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/tunnel") {
    res.statusCode = 426;
    res.setHeader("upgrade", "websocket");
    res.end("upgrade required: /tunnel is a WebSocket endpoint");
    return;
  }
  if (path === "/events") return handleEvents(req, res);
  if (path === "/registry") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(registry.list(), null, 2));
    return;
  }
  if (path === "/call") {
    handleCall(req, res).catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String((e as Error).message ?? e) }));
    });
    return;
  }
  if (path === "/" || path === "/index.html") {
    void serveStatic(res, "index.html");
    return;
  }
  if (path === "/app.js" || path === "/style.css") {
    void serveStatic(res, path.slice(1));
    return;
  }
  res.statusCode = 404;
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/tunnel") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => acceptTunnel(ws));
});

// SSE stream needs idle timeouts disabled; same posture as the PoC.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

// Stale-detection sweep — runs every second; flips connectors whose heartbeat
// is older than 4.5s to "stale" in the UI.
setInterval(() => registry.markStale(), 1000);

server.listen(port, () => {
  console.log(`[local-controller] listening on http://localhost:${port}`);
  console.log(`  GET  /                  — UI`);
  console.log(`  WS   /tunnel            — connectors dial in here`);
  console.log(`  GET  /events            — SSE stream for the UI`);
  console.log(`  GET  /registry          — list connected connectors as JSON`);
  console.log(`  POST /call              — { connectorId, tool, arguments } → tools/call`);
  logInfo(`controller started on :${port}`);
});
