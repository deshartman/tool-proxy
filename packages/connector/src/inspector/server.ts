import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { FrameTap, WsState } from "../tunnel/client.js";
import type { ToolManifest } from "../tunnel/frames.js";

// SSE event shape (mirrored as JSON.stringify(payload)).
export type InspectorEvent =
  | { kind: "snapshot"; controllerUrl: string; state: WsState; manifest?: ToolManifest; frames: FrameTap[] }
  | { kind: "state"; state: WsState }
  | { kind: "frame"; tap: FrameTap }
  | { kind: "manifest"; manifest: ToolManifest };

export interface InspectorState {
  controllerUrl: string;
  state: WsState;
  manifest?: ToolManifest;
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

  setState(state: WsState): void {
    this.current.state = state;
    this.broadcast({ kind: "state", state });
  }

  setManifest(manifest: ToolManifest): void {
    this.current.manifest = manifest;
    this.broadcast({ kind: "manifest", manifest });
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
      manifest: this.current.manifest,
      frames: [...this.frames],
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
    if (path === "/" || path === "/index.html") { void serveStatic(res, "index.html"); return; }
    if (path === "/app.js" || path === "/style.css") { void serveStatic(res, path.slice(1)); return; }
    res.statusCode = 404;
    res.end();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.listen(port, () => {
    const snap = inspector.snapshot();
    const url = snap.kind === "snapshot" ? snap.controllerUrl : "?";
    console.log(`[inspector] http://localhost:${port}/  (watching ${url})`);
  });
}
