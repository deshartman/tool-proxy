import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { acceptTunnel, tokenAuthOk } from "./tunnel-server.js";
import { registry } from "./registry.js";
import { route } from "./router.js";
import { eventBus } from "./event-bus.js";
import type { UiEvent, UiPayload } from "@mcp-shim/shared";

const port = Number(process.env.PORT ?? 8080);
// Note: the main server no longer holds any LLM credential. Routing is
// deterministic (keyword match) and answer generation runs entirely in shims
// using each customer's own key. This is a stronger residency posture than
// the original plan — the cloud has zero LLM API access.

// Resolve the client package's static files relative to the built dist file.
// __dirname is dist/ at runtime; client assets live at ../../client/.
const clientDir = resolvePath(__dirname, "../../client");
const clientIndexPath = resolvePath(clientDir, "index.html");

function publishCloud(message: string, level: "info" | "detail" = "info"): void {
  const ev: UiEvent = { source: "main", panel: "cloud", level, message, ts: Date.now() };
  eventBus.publish(ev);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST required" }));
    return;
  }
  const body = (await readJsonBody(req)) as { q?: string };
  const question = body.q;
  if (!question) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "missing 'q'" }));
    return;
  }

  publishCloud(`query received: "${question}"`);
  console.log(`[query] received: ${question}`);
  publishCloud(`asking all shims for confidence scores in parallel`, "detail");
  const { decision, scores } = await route(question);
  const scoreSummary = scores
    .map((s) => `${s.shimId}=${s.score}`)
    .join(", ");
  publishCloud(`scores: ${scoreSummary}`);
  if (!decision) {
    publishCloud(`no shim matched the query (top score below threshold)`);
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "no shim could handle this query", scores }));
    return;
  }
  publishCloud(`routed to ${decision.shimId}/${decision.procedureId}`);
  console.log(`[query] routed to ${decision.shimId}/${decision.procedureId}`);

  const shim = registry.get(decision.shimId);
  if (!shim) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "selected shim disconnected" }));
    return;
  }

  const queryId = randomUUID();
  publishCloud(`query started: ${queryId}`, "detail");
  publishCloud(`calling ask_procedure on ${decision.shimId}`, "detail");
  const result = await shim.client.callTool({
    name: "ask_procedure",
    arguments: { question, queryId },
  });

  const text = Array.isArray(result.content)
    ? result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n")
    : "";

  publishCloud(`answer received (${text.length} chars)`);
  console.log(`[query] answered (${text.length} chars)`);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      shimId: decision.shimId,
      procedureId: decision.procedureId,
      queryId,
      answer: text,
    })
  );
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  // Replay buffered events so a fresh tab catches up. Tokens are not buffered.
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
      // ignore
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
  // Whitelist by extension; resolve against clientDir and reject any traversal.
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

  if (path === "/tunnel") {
    // The tunnel is a WebSocket endpoint. A bare GET/POST here is wrong —
    // clients must send an Upgrade: websocket request, which the server
    // handles via the `upgrade` event below.
    res.statusCode = 426;
    res.setHeader("upgrade", "websocket");
    res.end("upgrade required: /tunnel is a WebSocket endpoint");
    return;
  }
  if (path === "/query") {
    handleQuery(req, res).catch((e) => {
      console.error("[query] handler error:", e);
      try {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      } catch {
        // already ended
      }
    });
    return;
  }
  if (path === "/events") {
    handleEvents(req, res);
    return;
  }
  if (path === "/registry") {
    const data = registry.list().map((s) => ({
      shimId: s.shimId,
      procedures: s.procedures,
    }));
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  // Document mutation lives on the laptop's local-server, not here. The
  // cloud has no /docs endpoint by design.
  if (path === "/" || path === "/index.html") {
    // Default this tab to the chat view. Visitors can still open ?view=full
    // for the original 4-column layout, or ?view=shim if they want the
    // mirror layout served from here too (it'd just be empty of shim events
    // unless they're forwarded through this tab's SSE stream).
    if (path === "/" && !url.searchParams.has("view")) {
      res.statusCode = 302;
      res.setHeader("location", "/?view=chat");
      res.end();
      return;
    }
    serveClient(res).catch((e) => {
      console.error("[client] error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  if (path === "/app.js") {
    serveStatic(res, "app.js").catch((e) => {
      console.error("[client] static error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

// WebSocket upgrade for /tunnel. Auth check happens here, before the
// handshake completes — unauthorized shims get a 401 and never see a
// WebSocket open.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  if (url.pathname !== "/tunnel") {
    socket.destroy();
    return;
  }
  if (!tokenAuthOk(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => acceptTunnel(ws));
});

// HTTP server timeouts don't apply to upgraded WebSockets, but SSE
// (`/events`) does ride a long-lived response. Keep these disabled so the
// SSE stream survives idle periods.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(port, () => {
  console.log(`[main-server] listening on http://localhost:${port}`);
  if (process.env.TUNNEL_AUTH_TOKEN) {
    console.log(`  /tunnel auth: REQUIRED (TUNNEL_AUTH_TOKEN set)`);
  } else {
    console.warn(`  /tunnel auth: DISABLED — set TUNNEL_AUTH_TOKEN for production`);
  }
  console.log(`  GET  /                  — demo UI`);
  console.log(`  WS   /tunnel            — shims dial in here`);
  console.log(`  POST /query             — user queries`);
  console.log(`  GET  /events            — SSE stream for the UI`);
  console.log(`  GET  /registry          — list connected shims`);
});
