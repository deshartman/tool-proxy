// local-server — laptop-side control plane.
//
// Roles:
//   1. Receives event/token frames from each shim (POST /events) and
//      broadcasts them via SSE (GET /events) to the laptop browser tab.
//   2. Mutates customer-side documents on disk (POST /docs/:shim/:source/change).
//      The Fly server has NO /docs endpoint — document state is the customer's,
//      and the cloud has no business in that path.
//
// Configuration: SHIM_CONFIGS env var is a comma-separated list of shim YAML
// config paths (the same files the shims themselves load). At startup we read
// each one to build a map of {shimId, sourceId} -> {absolutePath, variants}
// so doc-change requests can find and swap the right file directly.
//
// Production posture: this process is laptop-only. It opens an inbound port,
// which a real customer environment may or may not allow. Gating happens via
// LOCAL_SERVER_PORT — when unset, this process is simply not started.

import "dotenv/config";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  applyVariantInFile,
  type DocVariants,
  type UiEvent,
  type UiPayload,
  type UiTokenEvent,
} from "@mcp-shim/shared";
import { eventBus } from "./event-bus.js";

const port = Number(process.env.LOCAL_SERVER_PORT ?? process.env.PORT ?? 9000);
const expectedToken = process.env.LOCAL_SERVER_TOKEN;
if (!expectedToken) {
  console.warn(
    "[local-server] LOCAL_SERVER_TOKEN unset — accepting unauthenticated POST /events. Set in production."
  );
}

// Resolve packages/client/ relative to this file. At runtime __dirname is
// dist/; index.html lives at ../../client/index.html (peer workspace).
const clientDir = resolvePath(__dirname, "../../client");
const clientIndexPath = resolvePath(clientDir, "index.html");

// ─── Shim config registry (built at startup) ──────────────────────────
interface ShimSourceEntry {
  shimId: string;
  sourceId: string;
  absolutePath: string;
  variants: DocVariants;
}

function loadShimConfigs(spec: string | undefined): Map<string, ShimSourceEntry> {
  const out = new Map<string, ShimSourceEntry>();
  if (!spec) {
    console.warn("[local-server] SHIM_CONFIGS unset — /docs/.../change will 404.");
    return out;
  }
  const paths = spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of paths) {
    const absolute = resolvePath(p);
    let parsed: { shimId: string; sources: Array<{ id: string; path?: string; variants?: DocVariants }> };
    try {
      parsed = parseYaml(readFileSync(absolute, "utf8"));
    } catch (e) {
      console.error(`[local-server] failed to read shim config ${absolute}:`, e);
      continue;
    }
    const configDir = dirname(absolute);
    for (const src of parsed.sources ?? []) {
      if (!src.path || !src.variants) continue;
      const docPath = resolvePath(configDir, src.path);
      out.set(`${parsed.shimId}/${src.id}`, {
        shimId: parsed.shimId,
        sourceId: src.id,
        absolutePath: docPath,
        variants: src.variants,
      });
      console.log(`[local-server] registered ${parsed.shimId}/${src.id} -> ${docPath}`);
    }
  }
  return out;
}

const shimRegistry = loadShimConfigs(process.env.SHIM_CONFIGS);

// ─── Auth ──────────────────────────────────────────────────────────────
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

// ─── Event ingest / SSE ───────────────────────────────────────────────
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

// ─── Doc change ───────────────────────────────────────────────────────
async function handleDocChange(
  req: IncomingMessage,
  res: ServerResponse,
  shimId: string,
  sourceId: string
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const entry = shimRegistry.get(`${shimId}/${sourceId}`);
  if (!entry) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: `unknown shim/source: ${shimId}/${sourceId}` }));
    return;
  }
  // Optional body: { variant: "original" | "alternate" }. Empty = toggle.
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  let target: "original" | "alternate" | undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { variant?: unknown };
      if (parsed.variant === "original" || parsed.variant === "alternate") {
        target = parsed.variant;
      }
    } catch {
      /* ignore malformed body */
    }
  }
  try {
    const active = await applyVariantInFile(entry.absolutePath, entry.variants, target);
    // Surface the change in the local UI's event log so the user sees feedback.
    eventBus.publish({
      source: shimId,
      panel: "shim",
      level: "info",
      message: `document switched to variant: ${active} (via local-server)`,
      ts: Date.now(),
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, variant: active }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}

// ─── Static (HTML/JS) ─────────────────────────────────────────────────
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

// ─── Server ────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const path = url.pathname;

  if (path === "/events" && req.method === "POST") {
    handleEventsIngest(req, res).catch((e) => {
      console.error("[local-server] /events ingest error:", e);
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
  const docMatch = /^\/docs\/([^/]+)\/([^/]+)\/change$/.exec(path);
  if (docMatch) {
    handleDocChange(req, res, docMatch[1], docMatch[2]).catch((e) => {
      console.error("[local-server] /docs/.../change error:", e);
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        /* already ended */
      }
    });
    return;
  }
  if (path === "/" || path === "/index.html") {
    if (path === "/" && !url.searchParams.has("view")) {
      res.statusCode = 302;
      res.setHeader("location", "/?view=shim");
      res.end();
      return;
    }
    serveClient(res).catch((e) => {
      console.error("[local-server] client error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  if (path === "/app.js") {
    serveStatic(res, "app.js").catch((e) => {
      console.error("[local-server] static error:", e);
      res.statusCode = 500;
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

// SSE stays open indefinitely; same fix as main-server.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(port, () => {
  console.log(`[local-server] listening on http://localhost:${port}`);
  if (expectedToken) {
    console.log(`  /events ingest auth: REQUIRED`);
  } else {
    console.warn(`  /events ingest auth: DISABLED — set LOCAL_SERVER_TOKEN`);
  }
  console.log(`  GET  /                              — laptop-side UI (auto-redirects to ?view=shim)`);
  console.log(`  POST /events                        — shim event ingest (NDJSON)`);
  console.log(`  GET  /events                        — SSE stream to browser`);
  console.log(`  POST /docs/:shim/:src/change        — toggle doc variant on disk`);
  console.log(`  registered shim sources: ${shimRegistry.size}`);
});
