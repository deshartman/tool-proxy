import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameTap, WsState } from "../tunnel/client.js";
import type { ToolManifest } from "../tunnel/frames.js";
import type { WebhookRegistry, WebhookEvent } from "../tunnel/webhook-registry.js";
import type { McpStatus } from "../mcp-supervisor.js";
import type { McpMessageTap } from "../servers/message-tap.js";
import { createLogger } from "../logger.js";
import { envString } from "../env.js";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import { isLoopbackAddr } from "./network-access.js";
import type { NetworkAccessRoutes } from "./network-access-routes.js";

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
  | { kind: "controllerUrl"; controllerUrl: string }
  | { kind: "tunnelConfigChanged" }
  | { kind: "frame"; tap: FrameTap }
  | { kind: "manifest"; manifest: ToolManifest }
  | { kind: "webhooks"; webhooks: WebhookSummary[] }
  | { kind: "mcpStatuses"; mcpStatuses: McpStatus[] }
  | { kind: "mcpMessage"; tap: McpMessageTap }
  | { kind: "mcpMessagesCleared"; mcp: string };

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
  // F7: verify a bearer token presented on /internal/webhook/* against
  // per-MCP secrets minted at spawn. Returns the MCP name that owns the
  // token, or undefined if no match. Constant-time-compared server-side.
  // Backed by supervisor.resolveMcpByWebhookToken.
  resolveMcpByWebhookToken?(token: string): string | undefined;
  // v1.4: code-trust gate for /internal/controller-api/call — is `name`
  // Twilio-authored bundled code (never a customer drop-in)? Backed by
  // supervisor.isAuthorTwilio.
  isAuthorTwilio?(name: string): boolean;
  // v1.4: invoke a named controller-side action on behalf of `mcp` (caller
  // has already verified `mcp` via resolveMcpByWebhookToken + isAuthorTwilio
  // before reaching here). Rejects with a typed { code, message } error —
  // "tunnel_unavailable" when no tunnel is connected, otherwise whatever the
  // coordinator/controller returned (including "timeout").
  callControllerApi?(mcp: string, action: string, params: unknown, timeoutMs?: number): Promise<unknown>;
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

export function guardCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers["content-type"] ?? "";
  const customHeader = req.headers["x-inspector-request"];

  const isJson = contentType.toLowerCase().startsWith("application/json");
  const hasCustomHeader = customHeader === "1" || (typeof customHeader === "string" && customHeader.length > 0);

  if (!isJson || !hasCustomHeader) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Forbidden: CSRF check failed" }));
    return false;
  }
  return true;
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

  // CONNECTOR-NETWORK-EXPOSURE — API-client management routes (add/list/
  // revoke). Operator actions, reached from the same loopback-only trust
  // as everything else in this class — there is no admin session concept.
  networkAccessRoutes?: NetworkAccessRoutes;

  wireNetworkAccessRoutes(routes: NetworkAccessRoutes): void {
    this.networkAccessRoutes = routes;
  }

  // CONNECTOR-NETWORK-EXPOSURE — POST /oauth/token handler. Optional so
  // env/test boot paths that don't need the machine API can leave it
  // unwired (route falls through to 404, same convention as tunnelRoutes).
  oauthTokenHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

  wireOauthToken(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void {
    this.oauthTokenHandler = handler;
  }

  // CONNECTOR-NETWORK-EXPOSURE step 9 — POST /v1/outbound/calls handler.
  // Same optional-until-wired convention as oauthTokenHandler: unwired boot
  // paths fall through to 404.
  outboundCallsHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

  wireOutboundCalls(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void {
    this.outboundCallsHandler = handler;
  }

  // MEMORY-INJECTION — POST /v1/memory/events handler, the machine-API
  // sibling of outboundCallsHandler above. Same optional-until-wired
  // convention: unwired boot paths fall through to 404.
  memoryEventsHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

  wireMemoryEvents(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void {
    this.memoryEventsHandler = handler;
  }

  // MEMORY-INJECTION — POST /v1/identity/list, the resolve half of memory
  // injection's resolve-then-write flow (memoryEventsHandler above is the write
  // half). A sibling /v1/identity/find was wired here until the controller merged
  // the two: its exact lookup is subsumed by list's substring `identifier`, since
  // an exact address is a substring of itself. Same optional-until-wired
  // convention; kept as an object arg so a second identity route can rejoin
  // without changing the call site.
  identityListHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

  wireIdentityRoutes(handlers: {
    handleList: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): void {
    this.identityListHandler = handlers.handleList;
  }

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

  // Update the controller URL shown in the top-of-page header. Under db
  // mode the inspector is constructed with a placeholder URL before the
  // controllers row loads; bootFromDb calls this once the row is
  // available (initial dial + inspector-triggered configure/rotate).
  setControllerUrl(controllerUrl: string): void {
    this.current.controllerUrl = controllerUrl;
    this.broadcast({ kind: "controllerUrl", controllerUrl });
  }

  // Signal the UI's tunnel-config panel (Convo Agent card) to re-fetch
  // via GET /tunnel/config. Emitted after a successful register-ack under
  // db mode so the REGISTRATION badge flips from "not registered" to
  // "bound (len=N)" without requiring a page reload.
  publishTunnelConfigChanged(): void {
    this.broadcast({ kind: "tunnelConfigChanged" });
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

  private readonly mcpMessages = new Map<string, McpMessageTap[]>();
  private static readonly MCP_MESSAGE_RING_SIZE = 500;

  // Record one tap and broadcast it live. Called from the `record` callback
  // wrapWithMessageTap() is given, wired in boot/lifecycle.ts's onConnect.
  // Deliberately NOT included in snapshot() — per-MCP logs multiplied across
  // every connected MCP would bloat every subscriber's snapshot payload,
  // most of whom never open this pane. Fetched on demand via GET
  // /mcp/messages instead (see getMcpMessages).
  recordMcpMessage(tap: McpMessageTap): void {
    const list = this.mcpMessages.get(tap.mcp) ?? [];
    list.push(tap);
    if (list.length > Inspector.MCP_MESSAGE_RING_SIZE) {
      list.splice(0, list.length - Inspector.MCP_MESSAGE_RING_SIZE);
    }
    this.mcpMessages.set(tap.mcp, list);
    this.broadcast({ kind: "mcpMessage", tap });
  }

  // Read-only snapshot of one MCP's current log. Backs GET /mcp/messages.
  getMcpMessages(mcp: string): McpMessageTap[] {
    return [...(this.mcpMessages.get(mcp) ?? [])];
  }

  // Wipe one MCP's log and tell any open pane to clear. Called from the
  // restart action in boot/lifecycle.ts, BEFORE the child actually restarts.
  clearMcpMessages(mcp: string): void {
    this.mcpMessages.delete(mcp);
    this.broadcast({ kind: "mcpMessagesCleared", mcp });
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

// C1 + C11 — defense-in-depth headers on every static asset response.
//   default-src 'self'   — no cross-origin loads.
//   script-src 'self'    — no inline scripts, no eval. Every script must
//                          be an external file served by this same inspector.
//   style-src ... 'unsafe-inline' — inspector's app.js sets a few inline
//                          styles (backgrounds, borders); dropping it would
//                          break the UI. Refactor is a follow-up.
//   connect-src 'self'   — SSE + fetch back to the inspector only.
//   frame-ancestors 'none' — no clickjacking. X-Frame-Options: DENY for
//                          older browsers that ignore CSP frame-ancestors.
//   object-src 'none', base-uri 'self', form-action 'self' — misc hardening.
// nosniff neutralizes MIME sniffing so a static file served as text/plain
// can't be rendered as HTML by an older browser that guesses.
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

function setStaticSecurityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CSP_POLICY);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
}

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
    setStaticSecurityHeaders(res);
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

async function handleRevoke(req: IncomingMessage, res: ServerResponse, inspector: Inspector): Promise<void> {
  if (!guardCsrf(req, res)) return;
  const reg = inspector.webhookRegistry();
  if (!reg) { res.statusCode = 503; res.end("webhook registry not configured"); return; }
  let body: RevokeBody;
  try { body = (await readJsonBody(req) as RevokeBody) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end("payload too large"); return; }
    res.statusCode = 400; res.end("malformed body"); return;
  }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) { res.statusCode = 400; res.end('missing "mcp"'); return; }
  if (!authorizeWebhookMcp(req, res, inspector, mcp)) return;
  reg.revoke(mcp);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
  inspector.publishWebhookSnapshot();
}

// F7: verify the caller's bearer token identifies them as owner of `mcp`.
// Loopback-trust alone is NOT enough — a sibling MCP running in the same
// container (same UID, same loopback) can otherwise subscribe to any other
// MCP's webhook events. The token is minted per-MCP by the supervisor and
// delivered to the child as MCP_WEBHOOK_TOKEN; the SDK's
// createWebhookEndpoint sends it as Authorization: Bearer <token>.
// Returns true if authorized (caller may continue); false if not (response
// has already been written with 403).
function authorizeWebhookMcp(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
  requestedMcp: string,
): boolean {
  const resolve = inspector.mcpActions?.resolveMcpByWebhookToken;
  // If no resolver wired (test harness / older boot path), permit — the
  // production boot path always wires it. Tests that want to exercise the
  // auth gate must provide the resolver.
  if (!resolve) return true;
  const header = req.headers["authorization"];
  const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  const token = m?.[1]?.trim();
  const owner = token ? resolve(token) : undefined;
  if (owner !== requestedMcp) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"webhook subscription: token does not match requested MCP"}');
    return false;
  }
  return true;
}

interface ControllerApiCallBody {
  action?: unknown;
  params?: unknown;
  timeoutMs?: unknown;
}

// v1.4 — Controller API calls (Twilio-bundled only). Reuses the webhook
// per-MCP bearer token (MCP_WEBHOOK_TOKEN) rather than minting a second
// token — same identity proof as /internal/webhook/*, via
// resolveMcpByWebhookToken. Layers the code-trust gate (isAuthorTwilio) on
// top before the call ever reaches the tunnel. This route is the transport;
// Twilio-authored Node bundles reach it through the nicer callControllerApi
// SDK helper, which is a thin wrapper around it. The route stays separately
// addressable so a bundle with no in-process SDK path can still call it.
async function handleControllerApiCall(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.resolveMcpByWebhookToken || !actions.isAuthorTwilio || !actions.callControllerApi) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { code: "not_configured", message: "controller API calls not configured" } }));
    return;
  }

  const header = req.headers["authorization"];
  const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  const token = m?.[1]?.trim();
  const mcp = token ? actions.resolveMcpByWebhookToken(token) : undefined;
  if (!mcp) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { code: "not_authorized", message: "invalid or missing bearer token" } }));
    return;
  }
  if (!actions.isAuthorTwilio(mcp)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { code: "not_authorized", message: "MCP is not Twilio-authored" } }));
    return;
  }

  let body: ControllerApiCallBody;
  try { body = (await readJsonBody(req) as ControllerApiCallBody) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end(JSON.stringify({ error: { code: "payload_too_large", message: "payload too large" } })); return; }
    res.statusCode = 400; res.end(JSON.stringify({ error: { code: "bad_request", message: "malformed body" } })); return;
  }
  const action = typeof body.action === "string" ? body.action : undefined;
  if (!action) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: "bad_request", message: 'missing "action"' } }));
    return;
  }
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;

  try {
    const result = await actions.callControllerApi(mcp, action, body.params, timeoutMs);
    res.statusCode = 200;
    res.end(JSON.stringify({ result }));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "controller_error";
    const message = (err as Error)?.message ?? String(err);
    // "tunnel_unavailable" (no live tunnel) is a 503 — distinct from a
    // round-trip that actually reached the controller and failed (502).
    res.statusCode = code === "tunnel_unavailable" ? 503 : 502;
    res.end(JSON.stringify({ error: { code, message } }));
  }
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
  if (!guardCsrf(req, res)) return;
  const dispatch = inspector.toolDispatch;
  if (!dispatch) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"tool dispatch not configured"}');
    return;
  }

  let body: ToolCallBody;
  try { body = (await readJsonBody(req) as ToolCallBody) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end('{"ok":false,"error":"payload too large"}'); return; }
    res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return;
  }

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
  if (!guardCsrf(req, res)) return;
  const actions = inspector.mcpActions;
  if (!actions) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"mcp actions not configured"}');
    return;
  }
  let body: McpActionBody;
  try { body = (await readJsonBody(req) as McpActionBody) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end('{"ok":false,"error":"payload too large"}'); return; }
    res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return;
  }
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

// Standalone "Clear" button next to Restart on the MCP Status row — wipes
// that MCP's message-history log without touching the child process.
// Doesn't go through McpActions/the supervisor at all: Inspector owns the
// log directly (same as `frames`), so there's nothing to route through.
async function handleClearMcpMessages(
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  let body: McpActionBody;
  try { body = (await readJsonBody(req) as McpActionBody) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end('{"ok":false,"error":"payload too large"}'); return; }
    res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return;
  }
  const mcp = typeof body.mcp === "string" ? body.mcp : undefined;
  if (!mcp) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":false,"error":"missing mcp"}');
    return;
  }
  inspector.clearMcpMessages(mcp);
  res.statusCode = 202;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
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
  if (!guardCsrf(req, res)) return;
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.applySessionCreds) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"applySessionCreds not configured"}');
    return;
  }
  let body: { mcp?: unknown; env?: unknown };
  try { body = (await readJsonBody(req) as { mcp?: unknown; env?: unknown }) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end('{"ok":false,"error":"payload too large"}'); return; }
    res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return;
  }
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
  if (!guardCsrf(req, res)) return;
  const actions = inspector.mcpActions;
  res.setHeader("content-type", "application/json");
  if (!actions?.clearSessionCreds) {
    res.statusCode = 503;
    res.end('{"ok":false,"error":"clearSessionCreds not configured"}');
    return;
  }
  let body: { mcp?: unknown };
  try { body = (await readJsonBody(req) as { mcp?: unknown }) ?? {}; }
  catch (error) {
    if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end('{"ok":false,"error":"payload too large"}'); return; }
    res.statusCode = 400; res.end('{"ok":false,"error":"malformed body"}'); return;
  }
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
  req: IncomingMessage,
  res: ServerResponse,
  inspector: Inspector,
): Promise<void> {
  if (!guardCsrf(req, res)) return;
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
  if (!authorizeWebhookMcp(req, res, inspector, mcp)) return;

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

// CONNECTOR-NETWORK-EXPOSURE — routes reachable from a non-loopback
// caller. There is no admin login: the operator UI (dashboard, tool
// calls, tunnel config, API-client management, everything else in this
// dispatch table) is loopback-only, unconditionally, forever. The ONLY
// things a non-loopback caller can ever reach are the machine API's
// /oauth/token (self-authenticated via client_id/client_secret in the
// body) and the JWT-bearer-gated /v1/* routes (/v1/outbound/calls, see
// outbound-calls-route.ts; /v1/memory/events, see memory-events-route.ts;
// /v1/identity/list, see identity-routes.ts) — all of which do their own
// auth check inline, mirroring how authorizeWebhookMcp() works today.
//
// /v1/identity/list is the first entry here that returns bulk customer PII
// rather than performing one targeted action; see identity-routes.ts's
// header for why that's an accepted widening and what it means for the
// blast radius of a leaked bearer.
//
// /v1/identity/find was briefly a member and is deliberately NOT here any
// more — the controller deleted the action, so it must fall through to the
// non-loopback rejection like any other unknown path.
const NON_LOOPBACK_ALLOWED_PATHS = new Set([
  "/oauth/token",
  "/v1/outbound/calls",
  "/v1/memory/events",
  "/v1/identity/list",
]);

// One check point for the whole dispatch table. Loopback callers pass
// through unchanged — the permanent, never-gated path (CLAUDE.md
// "Inspector port is localhost-only"). A non-loopback caller on any path
// outside NON_LOOPBACK_ALLOWED_PATHS gets 403, full stop — no login flow,
// no session, nothing to opt into for the operator UI.
function isAuthorizedRequest(req: IncomingMessage, path: string): boolean {
  if (isLoopbackAddr(req.socket.remoteAddress)) return true;
  return NON_LOOPBACK_ALLOWED_PATHS.has(path);
}

export function startInspector(port: number, inspector: Inspector, opts?: { networkAccessEnabled?: boolean }): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!isAuthorizedRequest(req, path)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":false,"error":"forbidden: loopback only"}');
      return;
    }

    if (path === "/events") return handleEvents(req, res, inspector);
    if (path === "/reconnect" && req.method === "POST") {
      if (!guardCsrf(req, res)) return;
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
    if (path === "/internal/controller-api/call" && req.method === "POST") {
      void handleControllerApiCall(req, res, inspector);
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
    if (path === "/mcp/messages/clear" && req.method === "POST") {
      void handleClearMcpMessages(req, res, inspector);
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
    if (path === "/mcp/messages" && req.method === "GET") {
      const mcp = url.searchParams.get("mcp");
      if (!mcp) { res.statusCode = 400; res.end('missing "mcp" query param'); return; }
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, messages: inspector.getMcpMessages(mcp) }));
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

    // CONNECTOR-NETWORK-EXPOSURE — API-client management routes. Always
    // wired at boot (unlike tunnelRoutes, which is DB-mode-only) since the
    // api_clients table lives in the same always-present ConfigStore.
    // Loopback-only per the gate above — these are operator actions.
    if (path === "/internal/network-access/status" && req.method === "GET") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleStatus(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/clients" && req.method === "POST") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleAddClient(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/clients" && req.method === "GET") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleListClients(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/clients/revoke" && req.method === "POST") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleRevokeClient(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/clients/delete" && req.method === "POST") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleDeleteClient(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    // FEDERATED-JWT-MODE — trusted-issuer config, folded into the same
    // NetworkAccessRoutes factory (same deps, same loopback-only trust tier).
    if (path === "/internal/network-access/trusted-issuer" && req.method === "GET") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleGetTrustedIssuer(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/trusted-issuer" && req.method === "POST") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleSetTrustedIssuer(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/internal/network-access/trusted-issuer/clear" && req.method === "POST") {
      if (inspector.networkAccessRoutes) { void inspector.networkAccessRoutes.handleClearTrustedIssuer(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/oauth/token" && req.method === "POST") {
      if (inspector.oauthTokenHandler) { void inspector.oauthTokenHandler(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/v1/outbound/calls" && req.method === "POST") {
      if (inspector.outboundCallsHandler) { void inspector.outboundCallsHandler(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/v1/memory/events" && req.method === "POST") {
      if (inspector.memoryEventsHandler) { void inspector.memoryEventsHandler(req, res); return; }
      res.statusCode = 404; res.end(); return;
    }
    if (path === "/v1/identity/list" && req.method === "POST") {
      if (inspector.identityListHandler) { void inspector.identityListHandler(req, res); return; }
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
  // (see CODE-DEPLOY design record §"What we do NOT do"), so the
  // inspector is only reachable via `fly proxy` from authenticated flyctl
  // sessions in the app's Fly org — the same trust surface as .internal
  // DNS.
  //
  // C4 (security hardening) — any non-loopback bind requires the operator
  // to also set INSPECTOR_ALLOW_NONLOOPBACK=1. Prevents a silent typo
  // (INSPECTOR_BIND_ADDR=0.0.0.0 on a host with a public IP) from exposing
  // the copy-able bcrypt-protected webhook URLs to the internet. Fly.io
  // deployments set both vars in fly.toml — the opt-in makes the widening
  // explicit and greppable.
  const envBindAddr = envString("INSPECTOR_BIND_ADDR", "127.0.0.1");
  const loopbackAddrs = new Set(["127.0.0.1", "::1", "localhost"]);
  // CONNECTOR-NETWORK-EXPOSURE — a separate, orthogonal mechanism from the
  // Fly-mesh escape hatch above: if the operator hasn't touched
  // INSPECTOR_BIND_ADDR (still at its loopback default) AND the DB says
  // network access was already enabled on a prior boot, bind non-loopback
  // directly — no INSPECTOR_ALLOW_NONLOOPBACK needed, because that env var
  // guards a DIFFERENT, unattended widening path (a typo'd env var); this
  // widening is the direct result of an operator action from a prior boot
  // (adding the first API client) that this same boot is now honoring.
  // An explicit INSPECTOR_BIND_ADDR override still takes precedence and
  // goes through the existing opt-in check unchanged.
  const bindAddr = (envBindAddr === "127.0.0.1" && opts?.networkAccessEnabled)
    ? NETWORK_ACCESS_BIND_ADDR
    : envBindAddr;
  if (!loopbackAddrs.has(bindAddr) && bindAddr !== NETWORK_ACCESS_BIND_ADDR) {
    if (envString("INSPECTOR_ALLOW_NONLOOPBACK", "") !== "1") {
      throw new Error(
        `INSPECTOR_BIND_ADDR="${bindAddr}" is non-loopback — refusing to bind. ` +
        `The inspector exposes copy-able webhook URLs by design; widening the bind is a security decision. ` +
        `If this is intentional (e.g. Fly.io fly.toml [env] using "::" behind a WireGuard mesh with 'fly ips list' empty), ` +
        `set INSPECTOR_ALLOW_NONLOOPBACK=1 in the same env config to acknowledge.`
      );
    }
    log.warn(
      { bindAddr, port },
      `inspector bind widened beyond loopback (INSPECTOR_ALLOW_NONLOOPBACK=1 set) — ensure the host has no public IP allocated`
    );
  }
  if (bindAddr === NETWORK_ACCESS_BIND_ADDR) {
    log.warn(
      { bindAddr, port },
      `inspector bind widened beyond loopback (an API client exists) — the operator UI stays loopback-only; only /oauth/token (and future JWT-protected machine routes) is reachable non-loopback`
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
  return server;
}

// CONNECTOR-NETWORK-EXPOSURE — the address adding the first API client
// rebinds to. Not operator-configurable (no such field exists in the
// Postgres table): "reachable from the rest of the customer's network"
// doesn't need a specific interface, and 0.0.0.0 is the standard choice
// for a container whose actual exposure is decided at the infra layer
// (K8s Service, security group, port mapping — see CLAUDE.md "Deploy
// target sweep"). Widening this bind only ever exposes /oauth/token (and
// future JWT-protected machine routes) — the gate above keeps every
// operator-UI route loopback-only regardless of the bind address.
const NETWORK_ACCESS_BIND_ADDR = "0.0.0.0";

// Live-rebinds an already-listening inspector server from its current
// address to NETWORK_ACCESS_BIND_ADDR, in-process — no restart, and the
// SAME Server object (so every route handler wired via startInspector's
// createServer callback keeps working unchanged). closeAllConnections()
// force-drops any lingering keep-alive/SSE sockets from the old bind so
// close()'s callback (and therefore the re-listen) fires promptly instead
// of waiting for those connections to end on their own; EventSource clients
// auto-reconnect afterward.
export function rebindInspector(server: Server, port: number, log: ReturnType<typeof createLogger>): void {
  const alreadyOpen = server.address();
  if (typeof alreadyOpen === "object" && alreadyOpen?.address === NETWORK_ACCESS_BIND_ADDR) {
    return; // already bound wide — adding a second/third API client is a no-op here
  }
  server.close(() => {
    server.listen(port, NETWORK_ACCESS_BIND_ADDR, () => {
      log.info({ port, bindAddr: NETWORK_ACCESS_BIND_ADDR }, `inspector live-rebound for network access`);
    });
  });
  server.closeAllConnections();
}
