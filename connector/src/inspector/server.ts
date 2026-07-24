import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameTap, WsState } from "../tunnel/client.js";
import type { ToolManifest } from "../tunnel/frames.js";
import type { WebhookRegistry, WebhookEvent } from "../tunnel/webhook-registry.js";
import type { McpStatus } from "../mcp-supervisor.js";
import { createLogger } from "../logger.js";
import { envString } from "../env.js";

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

// Operator-facing header info. Distinct from `Identity` (which is
// connector↔controller binding state) — these fields are static or
// time-anchored facts an operator wants visible in the inspector header
// without having to grep frame logs.
//
//   connectorName       From yaml `tunnel.name`. Set once at boot.
//   connectorId         Minted by the controller; arrives on register-ack.
//   environment         From yaml `tunnel.environment` (e.g. "dev", "prod").
//                       Set once at boot.
//   version             From CONNECTOR_VERSION env var (or "dev" if unset).
//                       Set once at boot.
//   lastRegisterAckAt   ISO timestamp of the last successful register-ack.
//                       Proves the binding is fresh, not stale.
//   tunnelOpenSinceAt   ISO timestamp of the last tunnel open. Resets on
//                       every reconnect; surfaces uptime since the last
//                       successful connect (not since process boot).
export interface HeaderInfo {
  connectorName?: string;
  connectorId?: string;
  environment?: string;
  version?: string;
  lastRegisterAckAt?: string;
  tunnelOpenSinceAt?: string;
}

// SSE event shape (mirrored as JSON.stringify(payload)).
export type InspectorEvent =
  | { kind: "snapshot"; controllerUrl: string; state: DisplayState; reconnect?: ReconnectInfo; identity?: Identity; header?: HeaderInfo; manifest?: ToolManifest; frames: FrameTap[]; webhooks?: WebhookSummary[]; mcpStatuses?: McpStatus[] }
  | { kind: "state"; state: DisplayState; reconnect?: ReconnectInfo }
  | { kind: "identity"; identity: Identity }
  | { kind: "header"; header: HeaderInfo }
  | { kind: "frame"; tap: FrameTap }
  | { kind: "manifest"; manifest: ToolManifest }
  | { kind: "webhooks"; webhooks: WebhookSummary[] }
  | { kind: "mcpStatuses"; mcpStatuses: McpStatus[] };

export interface WebhookEventSummary {
  body: unknown;
  queryParameters: Record<string, string | string[]>;
  headers?: Record<string, string>;
  receivedAt: number;
}

export interface WebhookSummary {
  mcp: string;
  url?: string;
  listeners: number;
  // Most recent events (newest first), arrived from the controller as `webhook`
  // frames. Bounded ringbuffer; full history lives in the Frames panel.
  recentEvents: WebhookEventSummary[];
}

export interface InspectorState {
  controllerUrl: string;
  state: DisplayState;
  reconnect?: ReconnectInfo;
  identity?: Identity;
  header?: HeaderInfo;
  manifest?: ToolManifest;
  webhooks?: WebhookRegistry;
  mcpStatuses?: McpStatus[];
}

// Per-MCP operator actions wired by boot/lifecycle. Routes return after
// the supervisor (or coordinator) has triggered the underlying work —
// they don't wait for completion. The UI re-renders from the next
// mcpStatuses snapshot. rescanLocal is the W-L2 entry point: re-scan
// MCP_DROPIN_DIR and reconcile new / removed folders against the
// running supervisor entries.
export interface McpActions {
  reloadCreds(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  rescanLocal?(): Promise<{ added: { name: string; toolsCount: number }[]; removed: string[]; unchanged: string[]; errors: { name: string; error: string }[] }>;
  // INSPECTOR-CREDS-VISIBILITY (W-S4): apply developer-pasted session env
  // values to an MCP from the inspector loopback UI. Returns the
  // expiresAt epoch-ms so the UI can render a countdown without
  // re-querying.
  // SECURITY: the route NEVER reads back values. The call signature here
  // is write-only: env in, expiry out. No GET /mcp/:name/session-creds.
  applySessionCreds?(name: string, env: Record<string, string>): Promise<{ expiresAt: number | undefined }>;
  // INSPECTOR-CREDS-VISIBILITY (W-S4): drop the session env layer for an
  // MCP. Used by the UI's Clear button and by automatic 12h TTL expiry
  // (the supervisor handles the latter internally; this is the operator
  // path).
  clearSessionCreds?(name: string): Promise<void>;
  // INSPECTOR-CREDS-VISIBILITY (W-S5): list the declared envKeys for an
  // MCP so the UI can render the right form fields. Read-only; never
  // returns values, only key NAMES. Backed by the supervisor's
  // `fetchEnvKeys(name)` which queries the running child's /envkeys
  // endpoint.
  fetchEnvKeys?(name: string): Promise<string[]>;
}

const RING_SIZE = 500;

// Inspector-driven tool invocation. The connector main loop wires this
// to the same `servers` map the dispatcher uses, so an operator running
// a tool from the inspector goes through the identical dispatch path as
// the controller — same callTool method on the LocalServer interface.
// Returns the raw result JSON the SDK gives us, or rejects with a clear
// error message that the inspector route surfaces as `{ok:false,error}`.
export type ToolDispatch = (server: string, tool: string, args: unknown) => Promise<unknown>;

export interface TunnelRouteHandlers {
  handleGetConfig: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  handlePostCreds: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  handleForceReregister: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export class Inspector {
  // Caller can wire this to its reconnect routine; invoked when the UI
  // POSTs /reconnect.
  onReconnect?: () => void;

  // Caller wires this to a callTool dispatcher; invoked when the UI POSTs
  // /tool/call. Optional — when undefined, the route returns 503.
  toolDispatch?: ToolDispatch;

  // Per-MCP operator actions (Reload creds / Restart MCP). Wired by the
  // boot loop; left undefined here means the routes return 503.
  mcpActions?: McpActions;

  // Tunnel routes — only wired in DB mode (bootFromDb). When undefined,
  // the routes return 404 (env mode).
  // Accessed by startInspector to dispatch tunnel routes.
  tunnelRoutes?: TunnelRouteHandlers;

  private readonly listeners = new Set<(e: InspectorEvent) => void>();
  private readonly frames: FrameTap[] = []
  private readonly current: InspectorState;

  constructor(initial: InspectorState) {
    this.current = initial;
  }

  // Wire tunnel routes — called by bootFromDb after creating the inspector.
  // Routes are loopback-only (127.0.0.1) and allow operators to configure
  // the controller tunnel via the inspector UI.
  wireTunnelRoutes(routes: TunnelRouteHandlers): void {
    this.tunnelRoutes = routes;
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

  setMcpStatuses(statuses: McpStatus[]): void {
    this.current.mcpStatuses = statuses;
    this.broadcast({ kind: "mcpStatuses", mcpStatuses: statuses });
  }

  setIdentity(identity: Identity): void {
    this.current.identity = identity;
    this.broadcast({ kind: "identity", identity });
  }

  // Patch one or more header fields. Caller passes only the fields that
  // changed; existing values are preserved. Triggers a `header` broadcast
  // so the UI can update without a full snapshot.
  setHeader(patch: HeaderInfo): void {
    const merged: HeaderInfo = this.current.header
      ? { ...this.current.header, ...patch }
      : { ...patch };
    this.current.header = merged;
    this.broadcast({ kind: "header", header: merged });
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
      header: this.current.header,
      manifest: this.current.manifest,
      frames: [...this.frames],
      webhooks: this.current.webhooks?.snapshot(),
      mcpStatuses: this.current.mcpStatuses,
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

// At runtime this resolves to dist/inspector/; static UI is at ../../public/.
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolvePath(here, "../../public");

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

interface ToolCallBody {
  server?: string;
  tool?: string;
  args?: unknown;
}

// Operator-driven tool invocation from the inspector UI. Goes through the
// connector's existing servers map (wired via inspector.toolDispatch in
// index.ts) so this exercises the same callTool path the controller uses
// for inbound RPC. Loopback-bound only — same trust boundary as the rest
// of the inspector. See CLAUDE.md "Inspector port is localhost-only".
async function handleToolCall(req: IncomingMessage, res: ServerResponse, inspector: Inspector): Promise<void> {
  const dispatch = inspector.toolDispatch;
  if (!dispatch) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"tool dispatch not configured"}');
    return;
  }

  let body: ToolCallBody;
  try { body = (await readJsonBody(req) as ToolCallBody) ?? {}; }
  catch { res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return; }

  const server = typeof body.server === "string" ? body.server : undefined;
  const tool = typeof body.tool === "string" ? body.tool : undefined;
  const args = body.args ?? {};
  if (!server || !tool) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: 'missing "server" or "tool"' }));
    return;
  }

  res.setHeader("content-type", "application/json");
  try {
    const result = await dispatch(server, tool, args);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.statusCode = 200;          // application-level error, not transport
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

interface McpActionBody { mcp?: unknown }

async function handleMcpAction(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
  action: "reloadCreds" | "restart",
): Promise<void> {
  const actions = inspector.mcpActions;
  if (!actions) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"mcp actions not configured"}');
    return;
  }
  let body: McpActionBody;
  try { body = (await readJsonBody(req) as McpActionBody) ?? {}; }
  catch { res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return; }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"missing mcp"}');
    return;
  }
  res.setHeader("content-type", "application/json");
  try {
    if (action === "reloadCreds") await actions.reloadCreds(mcp);
    else await actions.restart(mcp);
    res.statusCode = 202;
    res.end('{"ok":true}');
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// INSPECTOR-CREDS-VISIBILITY (W-S4): apply developer-pasted session env
// values for an MCP. Body shape: `{mcp: string, env: Record<string, string>}`.
// Response: `{ok: true, expiresAt: number | undefined}` — the value expiry
// epoch-ms, never the values themselves. Cred-leak guard: under no
// circumstance does this route's response body include the pasted values
// (W-S9 L1). The handler reads from a local env-map and hands the values
// to the supervisor; the values then live ONLY in the supervisor's private
// `entry.sessionEnv` until expiry or clear.
//
// Validation: rejects non-string keys/values, enforces a per-key length
// cap (8KB) so a malformed paste can't OOM the connector.
async function handleApplySessionCreds(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.applySessionCreds) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"applySessionCreds not configured"}');
    return;
  }
  let body: { mcp?: unknown; env?: unknown };
  try { body = (await readJsonBody(req) as { mcp?: unknown; env?: unknown }) ?? {}; }
  catch { res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return; }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) {
    res.statusCode = 400;
    res.end('{"ok":false,"error":"missing mcp"}');
    return;
  }
  const envRaw = body.env;
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) {
    res.statusCode = 400;
    res.end('{"ok":false,"error":"env must be an object"}');
    return;
  }
  const env: Record<string, string> = {};
  const MAX_VALUE_LEN = 8 * 1024;
  for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      res.statusCode = 400;
      res.end('{"ok":false,"error":"env values must be strings"}');
      return;
    }
    if (v.length > MAX_VALUE_LEN) {
      res.statusCode = 413;
      res.end('{"ok":false,"error":"env value too long"}');
      return;
    }
    env[k] = v;
  }
  try {
    const result = await actions.applySessionCreds(mcp, env);
    res.statusCode = 202;
    res.end(JSON.stringify({ ok: true, expiresAt: result.expiresAt }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// INSPECTOR-CREDS-VISIBILITY (W-S4): clear the session env layer for an
// MCP. Operator-driven path; the 12h TTL auto-clear is handled inside the
// supervisor without going through this route.
async function handleClearSessionCreds(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.clearSessionCreds) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"clearSessionCreds not configured"}');
    return;
  }
  let body: { mcp?: unknown };
  try { body = (await readJsonBody(req) as { mcp?: unknown }) ?? {}; }
  catch { res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return; }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) {
    res.statusCode = 400;
    res.end('{"ok":false,"error":"missing mcp"}');
    return;
  }
  try {
    await actions.clearSessionCreds(mcp);
    res.statusCode = 202;
    res.end('{"ok":true}');
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// INSPECTOR-CREDS-VISIBILITY (W-S4): single dispatch point for the
// session-creds POST routes. Returns true if the path matched (caller
// short-circuits), false otherwise. Folded together so the top-level
// startInspector dispatcher doesn't add cognitive complexity for each
// route variant.
function handleSessionCredsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
  path: string,
): boolean {
  if (path === "/mcp/session-creds-apply") {
    void handleApplySessionCreds(req, res, inspector);
    return true;
  }
  if (path === "/mcp/session-creds-clear") {
    void handleClearSessionCreds(req, res, inspector);
    return true;
  }
  return false;
}

// INSPECTOR-CREDS-VISIBILITY (W-S5): GET /mcp/env-keys?mcp=<name>. Read-
// only listing of the envKeys an MCP declared (key NAMES only — never
// values). Backs the UI's creds form so the operator sees exactly which
// fields to fill in.
async function handleEnvKeys(
  _req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
  mcp: string,
): Promise<void> {
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.fetchEnvKeys) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"fetchEnvKeys not configured"}');
    return;
  }
  try {
    const envKeys = await actions.fetchEnvKeys(mcp);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, envKeys }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

async function handleRescanLocal(
  _req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.rescanLocal) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"rescanLocal not configured"}');
    return;
  }
  try {
    const summary = await actions.rescanLocal();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ...summary }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
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

  // Node's http callback can't itself be async (it has a sync return type).
  // The IIFE keeps subscribe → send-url → onUrl-bind → snapshot in a flat
  // sequence the linter and reader can both follow, instead of pyramiding
  // through .then().catch() with mutating outer-scope state inside .then().
  let unsubscribeUrl: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  void (async () => {
    try {
      const handle = await reg.subscribe(mcp, onEvent);
      send("url", { url: handle.url });
      unsubscribe = handle.unsubscribe;
      unsubscribeUrl = handle.onUrl((url) => send("url", { url }));
      inspector.publishWebhookSnapshot();
    } catch (error) {
      send("error", { message: (error as Error).message });
      try { res.end(); } catch { /* ignore */ }
    }
  })();

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
    if (path === "/tool/call" && req.method === "POST") {
      void handleToolCall(req, res, inspector);
      return;
    }
    if (path === "/mcp/reload-creds" && req.method === "POST") {
      void handleMcpAction(req, res, inspector, "reloadCreds");
      return;
    }
    if (path === "/mcp/restart" && req.method === "POST") {
      void handleMcpAction(req, res, inspector, "restart");
      return;
    }
    if (path === "/mcp/rescan-local" && req.method === "POST") {
      void handleRescanLocal(req, res, inspector);
      return;
    }
    // INSPECTOR-CREDS-VISIBILITY (W-S4): write-only routes for the
    // developer-pasted session creds layer. The routes NEVER read back
    // values — there is no GET sibling. See W-S9 L1 in the plan.
    if (req.method === "POST" && handleSessionCredsRoute(req, res, inspector, path)) {
      return;
    }
    if (path === "/mcp/env-keys" && req.method === "GET") {
      const mcp = url.searchParams.get("mcp");
      if (!mcp) { res.statusCode = 400; res.end('missing "mcp" query param'); return; }
      void handleEnvKeys(req, res, inspector, mcp);
      return;
    }

    // Tunnel routes — only wired in DB mode (bootFromDb). Return 404 in env mode.
    if (path === "/internal/tunnel/config" && req.method === "GET") {
      if (inspector.tunnelRoutes) {
        void inspector.tunnelRoutes.handleGetConfig(req, res);
        return;
      }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/tunnel/creds" && req.method === "POST") {
      if (inspector.tunnelRoutes) {
        void inspector.tunnelRoutes.handlePostCreds(req, res);
        return;
      }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/tunnel/force-reregister" && req.method === "POST") {
      if (inspector.tunnelRoutes) {
        void inspector.tunnelRoutes.handleForceReregister(req, res);
        return;
      }
      res.statusCode = 404; res.end(); return;
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
  // Attach the listen-error handler BEFORE .listen() so EADDRINUSE (typically
  // a stale connector still holding the port) surfaces as an actionable
  // one-liner instead of Node's raw "Unhandled 'error' event" stack. Without
  // this listener the http.Server 'error' event has no consumer and Node
  // throws an uncaught exception, which pino can't format and start-connector
  // ends up printing four SIGTERM banners as the trap handler retries.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        {
          port,
          fix: `lsof -iTCP:${port} -sTCP:LISTEN -n -P  # find the pid, then: kill <pid>`,
          override: `set INSPECTOR_PORT=<other> in .env to run on a different port`,
        },
        `inspector port ${port} is already in use — another connector is likely still running`
      );
    } else {
      log.error({ err, port }, `inspector server failed to listen`);
    }
    // The inspector is load-bearing (loopback IPC for bundled MCPs, tunnel
    // routes under db mode, operator UI) — the connector can't do its job
    // without it. Exit cleanly rather than boot half-broken; the OS reaps
    // any MCP children we already spawned.
    process.exit(1);
  });
  // Default bind is 127.0.0.1 — loopback-only, the load-bearing invariant
  // for docker-compose, laptop dev, K8s (kubectl port-forward reaches
  // loopback inside the pod), Fargate (aws ecs execute-command), and ACA
  // (az containerapp exec). All four platforms establish "inside the
  // container" reach before touching 127.0.0.1.
  //
  // Fly.io is the special case that forced INSPECTOR_BIND_ADDR to exist:
  // `fly proxy` opens a WireGuard tunnel to the Machine's private-network
  // (fdaa:...) mesh IP, NOT to the Machine's 127.0.0.1. A loopback-only
  // bind is unreachable from `fly proxy`. Override to "::" in fly.toml
  // [env] so the inspector listens on all IPv6 interfaces including the
  // mesh. Trust posture is preserved: `fly ips list` MUST remain empty
  // (see architectural-plans/CODE-DEPLOY.md §"What we do NOT do"), so the
  // inspector is only reachable via `fly proxy` from authenticated flyctl
  // sessions in the app's Fly org — the same trust surface as .internal
  // DNS.
  //
  // Any non-127.0.0.1 override logs a WARN so operators see it loud, and
  // so a misconfigured non-Fly deploy doesn't silently widen the bind.
  const bindAddr = envString("INSPECTOR_BIND_ADDR", "127.0.0.1");
  if (bindAddr !== "127.0.0.1") {
    log.warn(
      { bindAddr, port },
      `inspector bind widened beyond loopback (INSPECTOR_BIND_ADDR set) — ensure the host has no public IP allocated`
    );
  }
  server.listen(port, bindAddr, () => {
    const snap = inspector.snapshot();
    const controllerUrl = snap.kind === "snapshot" ? snap.controllerUrl : "?";
    log.info(
      { port, bindAddr, url: `http://${bindAddr === "127.0.0.1" ? "127.0.0.1" : `[${bindAddr}]`}:${port}/`, controllerUrl },
      `listening`
    );
  });
}
