import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { FrameTap, WsState } from "../tunnel/client.js";
import type { ToolManifest } from "../tunnel/frames.js";
import type { WebhookRegistry, WebhookEvent } from "../tunnel/webhook-registry.js";
import { createLogger } from "../logger.js";

const log = createLogger("inspector");

// Inspector exposes a "reconnecting" state on top of the tunnel's WsState —
// the tunnel itself only knows connecting/open/closed; the reconnecting
// pseudostate is a connector-level concept (we're in a backoff window between
// attempts).
export type DisplayState = WsState | "reconnecting";

export interface ReconnectInfo {
  attempt: number;
  nextDelayMs: number;
}

// Identity status — surfaces the connector↔controller binding state in the
// inspector header. Distinct from the WS state (connecting/open/closed):
// even an open WS can be in 'first-connect' (no token yet) or 'rejected'
// (controller said no) at register-ack time.
export type Identity =
  | { kind: "first-connect" }                                              // no token on disk; will be minted on register-ack
  | { kind: "bound"; tokenLen: number }                                    // token persisted, last register-ack succeeded
  | { kind: "cleared" }                                                    // controller returned unknown_registration_token; we cleared the token and will re-mint
  | { kind: "rejected"; reason: string; message?: string };                // controller rejected with a sticky error (e.g. name_taken) — operator action required

// SSE event shape (mirrored as JSON.stringify(payload)).
export type InspectorEvent =
  | { kind: "snapshot"; controllerUrl: string; state: DisplayState; reconnect?: ReconnectInfo; identity?: Identity; manifest?: ToolManifest; frames: FrameTap[]; webhooks?: WebhookSummary[] }
  | { kind: "state"; state: DisplayState; reconnect?: ReconnectInfo }
  | { kind: "identity"; identity: Identity }
  | { kind: "frame"; tap: FrameTap }
  | { kind: "manifest"; manifest: ToolManifest }
  | { kind: "webhooks"; webhooks: WebhookSummary[] };

export interface WebhookSummary {
  mcp: string;
  url?: string;
  listeners: number;
}

export interface InspectorState {
  controllerUrl: string;
  state: DisplayState;
  reconnect?: ReconnectInfo;
  identity?: Identity;
  manifest?: ToolManifest;
  webhooks?: WebhookRegistry;
}

const RING_SIZE = 500;

export class Inspector {
  // Caller can wire this to its reconnect routine; invoked when the UI
  // POSTs /reconnect.
  onReconnect?: () => void;

  private readonly listeners = new Set<(e: InspectorEvent) => void>();
  private readonly frames: FrameTap[] = [];
  private readonly current: InspectorState;

  constructor(initial: InspectorState) {
    this.current = initial;
  }

  // Read-only handle for the IPC routes below.
  webhookRegistry(): WebhookRegistry | undefined {
    return this.current.webhooks;
  }

  // Push a fresh webhooks snapshot to all SSE subscribers. Called by the
  // /internal/webhook routes after they mutate the registry; the registry
  // itself is intentionally framework-agnostic.
  publishWebhookSnapshot(): void {
    const reg = this.current.webhooks;
    if (!reg) return;
    this.broadcast({ kind: "webhooks", webhooks: reg.snapshot() });
  }

  setState(state: WsState): void {
    this.current.state = state;
    this.current.reconnect = undefined;
    this.broadcast({ kind: "state", state });
  }

  // Distinct from setState: the connector is in a backoff window between
  // tunnel attempts. The tunnel itself is undefined here.
  setReconnecting(info: ReconnectInfo): void {
    this.current.state = "reconnecting";
    this.current.reconnect = info;
    this.broadcast({ kind: "state", state: "reconnecting", reconnect: info });
  }

  setManifest(manifest: ToolManifest): void {
    this.current.manifest = manifest;
    this.broadcast({ kind: "manifest", manifest });
  }

  setIdentity(identity: Identity): void {
    this.current.identity = identity;
    this.broadcast({ kind: "identity", identity });
  }

  recordTap(tap: FrameTap): void {
    this.frames.push(tap);
    if (this.frames.length > RING_SIZE) {
      this.frames.splice(0, this.frames.length - RING_SIZE);
    }
    this.broadcast({ kind: "frame", tap });
  }

  snapshot(): InspectorEvent {
    return {
      kind: "snapshot",
      controllerUrl: this.current.controllerUrl,
      state: this.current.state,
      reconnect: this.current.reconnect,
      identity: this.current.identity,
      manifest: this.current.manifest,
      frames: [...this.frames],
      webhooks: this.current.webhooks?.snapshot(),
    };
  }

  subscribe(fn: (e: InspectorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(e: InspectorEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
};

// __dirname is dist/inspector/ at runtime; static UI is at ../../public/.
const publicDir = resolvePath(__dirname, "../../public");

async function serveStatic(res: ServerResponse, name: string): Promise<void> {
  const ext = name.slice(name.lastIndexOf("."));
  const type = STATIC_TYPES[ext];
  if (!type || name.includes("..") || name.includes("/")) {
    res.statusCode = 404; res.end(); return;
  }
  try {
    const body = await readFile(resolvePath(publicDir, name));
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.end(body);
  } catch {
    res.statusCode = 404; res.end();
  }
}

function handleEvents(req: IncomingMessage, res: ServerResponse, inspector: Inspector): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const send = (e: InspectorEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send(inspector.snapshot());
  const unsubscribe = inspector.subscribe(send);
  const cleanup = () => {
    unsubscribe();
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

// SDK ↔ connector IPC. The bundled MCP child runs in its own process and uses
// these loopback HTTP routes to (a) stream webhook events as they arrive on
// the WS — opening the SSE stream IS the allocation — and (b) explicitly
// revoke an allocation when the SDK tears down early (graceful unmount).
// Inspector port is 127.0.0.1 only — the trust boundary is the localhost
// socket, not a separate auth scheme.

interface RevokeBody { mcp?: unknown }

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleRevoke(req: IncomingMessage, res: ServerResponse, inspector: Inspector): Promise<void> {
  const reg = inspector.webhookRegistry();
  if (!reg) { res.statusCode = 503; res.end("webhook registry not configured"); return; }
  let body: RevokeBody;
  try { body = (await readJsonBody(req) as RevokeBody) ?? {}; }
  catch { res.statusCode = 400; res.end("malformed body"); return; }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) { res.statusCode = 400; res.end('missing "mcp"'); return; }
  reg.revoke(mcp);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
  inspector.publishWebhookSnapshot();
}

function handleStream(req: IncomingMessage, res: ServerResponse, inspector: Inspector, mcp: string): void {
  const reg = inspector.webhookRegistry();
  if (!reg) { res.statusCode = 503; res.end("webhook registry not configured"); return; }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const send = (kind: string, payload: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onEvent = (event: WebhookEvent) => send("webhook", event);

  let unsubscribeUrl: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  reg.subscribe(mcp, onEvent).then((handle) => {
    send("url", { url: handle.url });
    unsubscribe = handle.unsubscribe;
    unsubscribeUrl = handle.onUrl((url) => send("url", { url }));
    inspector.publishWebhookSnapshot();
  }).catch((e: Error) => {
    send("error", { message: e.message });
    try { res.end(); } catch { /* ignore */ }
  });

  const cleanup = () => {
    unsubscribeUrl?.();
    unsubscribe?.();
    try { res.end(); } catch { /* ignore */ }
    inspector.publishWebhookSnapshot();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

export function startInspector(port: number, inspector: Inspector): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/events") return handleEvents(req, res, inspector);
    if (path === "/reconnect" && req.method === "POST") {
      inspector.onReconnect?.();
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    if (path === "/internal/webhook/revoke" && req.method === "POST") {
      void handleRevoke(req, res, inspector);
      return;
    }
    if (path === "/internal/webhook/stream" && req.method === "GET") {
      const mcp = url.searchParams.get("mcp");
      if (!mcp) { res.statusCode = 400; res.end('missing "mcp" query param'); return; }
      handleStream(req, res, inspector, mcp);
      return;
    }
    if (path === "/" || path === "/index.html") { void serveStatic(res, "index.html"); return; }
    if (path === "/app.js" || path === "/style.css") { void serveStatic(res, path.slice(1)); return; }
    res.statusCode = 404;
    res.end();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  // Bind 127.0.0.1 only. The inspector is the SDK ↔ connector IPC channel
  // (/internal/webhook/*) AND the operator UI; both expose secrets — the
  // bcrypt-protected webhook URL via the Webhooks panel, the frame log via
  // /events. Reach it from outside the container via port-forward / exec,
  // never via an LB. See CLAUDE.md "Inspector port is localhost-only and
  // carries copy-able webhook URLs".
  server.listen(port, "127.0.0.1", () => {
    const snap = inspector.snapshot();
    const controllerUrl = snap.kind === "snapshot" ? snap.controllerUrl : "?";
    log.info({ port, url: `http://127.0.0.1:${port}/`, controllerUrl }, `listening`);
  });
}
