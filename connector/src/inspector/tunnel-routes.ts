// Tunnel routes for the inspector. They let operators add, edit, remove and
// force re-registration of controller entries via the localhost inspector UI.
//
// Phase 6 (MULTI-PLATFORM-MCP §5.1): one controller entry = one workspace.
// Adding an entry starts a workspace, editing one cycles it, removing one
// stops it and deletes its storage. The pre-Phase-6 routes keep their
// single-controller contract — `/internal/tunnel/creds` with no `id`
// add-or-updates the first entry, and `/internal/tunnel/config` reports it —
// so a UI that predates the tunnel list keeps working.

import type { IncomingMessage, ServerResponse } from "node:http";
import { guardCsrf } from "./server.js";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import type { ConfigStore, ControllerInput, ControllerRow } from "../config-store/index.js";
import { isHttpsControllerUrl } from "../boot/require-env.js";

export interface TunnelConfigSummary {
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  hasTunnelAuthToken: boolean;
  hasOauthClientSecret: boolean;
  oauthClientId: string | null;
  oauthTokenUrl: string | null;
  hasRegistrationToken: boolean;
  registrationTokenLen?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastDisconnectReason: string | null;
}

function rowToSummary(row: ControllerRow): TunnelConfigSummary {
  return {
    id: row.id,
    name: row.name,
    controllerUrl: row.controllerUrl,
    connectorName: row.connectorName,
    environment: row.environment,
    authMode: row.authMode,
    hasTunnelAuthToken: row.tunnelAuthToken !== null,
    hasOauthClientSecret: row.oauthClientSecret !== null,
    oauthClientId: row.oauthClientId,
    oauthTokenUrl: row.oauthTokenUrl,
    hasRegistrationToken: row.registrationToken !== null,
    registrationTokenLen: row.registrationToken?.length,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastDisconnectReason: row.lastDisconnectReason,
  };
}

interface TunnelRoutesDeps {
  configStore: ConfigStore;
  // Start a workspace for a freshly-added entry.
  dialTunnel: (row: ControllerRow) => Promise<void>;
  // Re-read an entry and redial. `id` omitted = the only workspace.
  cycleTunnel: (reason: string, id?: string) => Promise<void>;
  // Stop a removed entry's workspace and delete its storage. Optional so
  // single-controller test harnesses can omit it.
  removeTunnel?: (id: string) => Promise<void>;
}

function setJsonHeaders(res: ServerResponse): void {
  res.setHeader("content-type", "application/json");
}

// Derive a default row name / connector identity from the controller URL's
// hostname (`https://tap-des.ngrok.dev` → `tap-des`). Used to fill columns
// on the DB row that used to be operator-typed but are now server-side
// cosmetic. Sent as X-Connector-Name on the WS upgrade until the controller
// accepts name-less upgrades. Falls back to "connector" if the URL is
// unparseable — that's a legitimate value; the operator can rename it in
// the controller UI at any time.
export function deriveDefaultNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // First DNS label is usually the meaningful one (`tap-des` from
    // `tap-des.ngrok.dev`). Strip anything non-alphanumeric-or-dash.
    const label = host.split(".")[0]?.replace(/[^A-Za-z0-9-]/g, "") ?? "";
    return label || "connector";
  } catch {
    return "connector";
  }
}

// Normalize a pasted Controller URL to the base URL the connector expects.
// The controller UI's "Copy Controller URL" button copies the full WS endpoint
// (e.g. https://tap-des.ngrok.dev/mcp-tunnel/tunnel) — but the connector
// appends `/mcp-tunnel` itself in tunnel/client.ts before opening the WS.
// Pasting the full URL would double-append and 404 on dial. Strip any
// trailing `/mcp-tunnel[/…]` path plus any trailing slashes so the stored
// value is always the bare scheme://host[:port] the connector wants.
//
// Idempotent: normalizing an already-base URL is a no-op.
export function normalizeControllerUrl(url: string): string {
  return url
    .trim()
    // strip trailing whitespace + any trailing /mcp-tunnel(/*)?
    .replace(/\/mcp-tunnel(?:\/[^?#]*)?$/i, "")
    // strip trailing slash
    .replace(/\/+$/, "");
}

// GET /internal/tunnel/config
async function handleGetConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  { configStore }: Pick<TunnelRoutesDeps, "configStore">
): Promise<void> {
  try {
    const row = await configStore.getController();
    // shimId rides on both answers: it exists from the first boot, before any
    // controller is configured, and is not secret (it is in every tool name).
    const shimId = configStore.getShimId();
    setJsonHeaders(res);
    if (!row) {
      res.statusCode = 200;
      res.end(JSON.stringify({ configured: false, shimId }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, shimId, row: rowToSummary(row) }));
  } catch (err) {
    setJsonHeaders(res);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// GET /internal/tunnels — every controller entry (one per workspace).
async function handleListTunnels(
  _req: IncomingMessage,
  res: ServerResponse,
  { configStore }: Pick<TunnelRoutesDeps, "configStore">
): Promise<void> {
  setJsonHeaders(res);
  try {
    const rows = await configStore.listControllers();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, shimId: configStore.getShimId(), rows: rows.map(rowToSummary) }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// POST /internal/tunnel/creds
// Body: ControllerInput-shaped JSON, plus an optional `id` naming the entry to
// edit. Without `id` this is the pre-Phase-6 single-controller upsert.
// Flow:
//   - Read the prior row FIRST — decides both INSERT-vs-UPDATE routing and
//     whether the auth secret is optional on this submit.
//   - Validate payload. On UPDATE where the operator is only changing Display
//     Name / Controller URL (same authMode, secret field blank), the secret
//     is treated as "keep existing" — the frontend renders a "leave blank to
//     keep existing" hint and the SQL COALESCE in upsertController preserves
//     the sealed value.
//   - Upsert the row.
//   - INSERT: dialTunnel(newRow). On dial failure, deleteController() to
//     roll back so the DB stays empty and the operator can retry cleanly.
//   - UPDATE: cycleTunnel("credential-rotated"). On dial failure, leave the
//     row in place (operator can retry after fixing bearer/DNS).
// Status codes:
//   200 — upsert + dial both succeeded
//   400 — payload validation failure
//   409 — dial rejection (INSERT rolled back; UPDATE row kept)
//   500 — DB error during upsert / getController / rollback
async function handlePostCreds(
  req: IncomingMessage,
  res: ServerResponse,
  { configStore, dialTunnel, cycleTunnel }: TunnelRoutesDeps,
  // "upsert": pre-Phase-6 — `id` names an entry to edit, absent edits the
  // first entry or adds one. "add": always a new entry (a new workspace).
  mode: "upsert" | "add" = "upsert",
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      res.statusCode = 413;
      res.end(JSON.stringify({ ok: false, error: "payload too large" }));
      return;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "malformed JSON body" }));
    return;
  }

  if (!body || typeof body !== "object") {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "body must be an object" }));
    return;
  }

  const b = body as Record<string, unknown>;

  // Two operator-required fields: controllerUrl + auth secret(s). Everything
  // else the DB row's shape still requires (name, connectorName, environment)
  // is filled with defaults derived from the URL — those columns are
  // controller-side-cosmetic under the ID-based identity model and will be
  // removed entirely once the controller's server-mint change lands (see
  // .claude/plans/CONNECTOR-ID-AS-IDENTITY.md).
  const controllerUrl = typeof b.controllerUrl === "string" ? b.controllerUrl : undefined;
  const authMode = b.authMode === "static-bearer" || b.authMode === "oauth2-cc" ? b.authMode : undefined;

  if (!controllerUrl || !authMode) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      ok: false,
      error: "missing required fields: controllerUrl, authMode",
    }));
    return;
  }

  // Optional legacy fields — accepted from callers that still send them, but
  // no longer required. Server auto-fills when absent.
  const legacyName = typeof b.name === "string" && b.name ? b.name : undefined;
  const legacyConnectorName = typeof b.connectorName === "string" && b.connectorName ? b.connectorName : undefined;
  const legacyEnvironment = typeof b.environment === "string" && b.environment ? b.environment : null;

  const normalizedUrl = normalizeControllerUrl(controllerUrl);

  // C5 (security hardening) — refuse plaintext. client.ts upgrades
  // http:// → ws:// silently, sending the tunnel bearer unencrypted.
  // Loopback URLs pass so dev/test dialling a local mock controller
  // works without TLS certs.
  if (!isHttpsControllerUrl(normalizedUrl)) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      ok: false,
      error: `controllerUrl must use https:// (got: ${controllerUrl}). Plaintext http:// would send the tunnel bearer over an unencrypted socket.`,
    }));
    return;
  }

  // Derive a default connector-identity string from the URL hostname. Used
  // as X-Connector-Name on the WS upgrade until the controller accepts
  // name-less upgrades (Path A). Once that lands, this field is unused.
  const defaultName = deriveDefaultNameFromUrl(normalizedUrl);

  const input: ControllerInput = {
    name: legacyName ?? defaultName,
    controllerUrl: normalizedUrl,
    // Settled below, once the prior row is read.
    connectorName: "",
    environment: legacyEnvironment,
    authMode,
  };

  // Read the prior row so we can (a) route INSERT vs UPDATE for dial
  // orchestration below, and (b) know whether the auth secret is optional
  // on this submit. The rule for (b): the secret may be blank IFF there is
  // a prior row with the SAME authMode and a non-null sealed secret — then
  // the SQL COALESCE in upsertController preserves the existing value. A
  // switch of authMode (static-bearer ↔ oauth2-cc) always requires the new
  // secret because there is no matching prior sealed value to preserve.
  const targetId = mode === "upsert" && typeof b.id === "string" && b.id ? b.id : undefined;
  let priorRow: ControllerRow | null;
  try {
    priorRow = mode === "add"
      ? null
      : targetId ? await configStore.getControllerById(targetId) : await configStore.getController();
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }
  if (targetId && !priorRow) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `no controller with id ${targetId}` }));
    return;
  }
  const hadPriorRow = priorRow !== null;
  // The modal sends no connectorName, so an edit must keep the stored one —
  // re-deriving it renamed a registered connector, whose next register then
  // hit name_taken. A new entry's default carries the shimId: the URL label
  // alone is the same for every shim on one host ("127" for 127.0.0.1).
  input.connectorName = legacyConnectorName
    ?? priorRow?.connectorName
    ?? `${defaultName}-${configStore.getShimId()}`;
  const canPreserveTunnelAuthToken = priorRow?.authMode === "static-bearer" && priorRow.tunnelAuthToken !== null;
  const canPreserveOauthClientSecret = priorRow?.authMode === "oauth2-cc" && priorRow.oauthClientSecret !== null;

  if (authMode === "static-bearer") {
    const token = typeof b.tunnelAuthToken === "string" && b.tunnelAuthToken ? b.tunnelAuthToken : undefined;
    if (!token && !canPreserveTunnelAuthToken) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "tunnelAuthToken is required when authMode is static-bearer" }));
      return;
    }
    if (token) input.tunnelAuthToken = token;
  } else {
    const clientId = typeof b.oauthClientId === "string" ? b.oauthClientId : undefined;
    const clientSecret = typeof b.oauthClientSecret === "string" && b.oauthClientSecret ? b.oauthClientSecret : undefined;
    const tokenUrl = typeof b.oauthTokenUrl === "string" ? b.oauthTokenUrl : undefined;
    if (!clientId || !tokenUrl) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        ok: false,
        error: "oauthClientId and oauthTokenUrl are required when authMode is oauth2-cc"
      }));
      return;
    }
    if (!clientSecret && !canPreserveOauthClientSecret) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        ok: false,
        error: "oauthClientSecret is required when authMode is oauth2-cc"
      }));
      return;
    }
    input.oauthClientId = clientId;
    input.oauthTokenUrl = tokenUrl;
    if (clientSecret) input.oauthClientSecret = clientSecret;
  }

  let newRow: ControllerRow;
  try {
    newRow = mode === "add"
      ? await configStore.addController(input)
      : priorRow && targetId ? await configStore.updateController(priorRow.id, input)
      : await configStore.upsertController(input);
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }

  try {
    if (hadPriorRow) {
      // Pass the id only when the caller named one, so the single-controller
      // contract (cycleTunnel(reason)) is unchanged for pre-Phase-6 callers.
      if (targetId) await cycleTunnel("credential-rotated", newRow.id);
      else await cycleTunnel("credential-rotated");
    } else {
      await dialTunnel(newRow);
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, id: newRow.id }));
  } catch (dialErr) {
    // Dial rejected. INSERT case: roll back THIS entry so the store holds
    // only entries that started. UPDATE case: leave it so the operator can retry.
    if (!hadPriorRow) {
      try {
        if (mode === "add") await configStore.removeController(newRow.id);
        else await configStore.deleteController();
      } catch {
        // Rollback failure is not the primary error — surface the dial
        // rejection to the operator and log the rollback issue elsewhere
        // if needed. Swallow here to avoid masking the actionable message.
      }
    }
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: (dialErr as Error).message }));
  }
}

// POST /internal/tunnel/force-reregister
async function handleForceReregister(
  req: IncomingMessage,
  res: ServerResponse,
  { configStore, cycleTunnel }: Pick<TunnelRoutesDeps, "configStore" | "cycleTunnel">
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);

  try {
    const id = await optionalId(req);
    const row = id ? await configStore.getControllerById(id) : await configStore.getController();
    if (!row) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: "no controller row configured" }));
      return;
    }

    await configStore.clearRegistrationToken(row.id);
    if (id) await cycleTunnel("force-reregister", row.id);
    else await cycleTunnel("force-reregister");

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// POST /internal/identity/regenerate
// Mints a new shimId — the fix for a cloned volume, where two shims share one
// identity. Operator-only: loopback (the server gate) plus CSRF (here). Every
// procedure ref to this shim's tools breaks until the platform re-points them,
// so the inspector confirms before calling this. Redials when a controller is
// configured so the next register carries the new id; with no controller
// there is nothing to redial.
async function handleRegenerateShimId(
  req: IncomingMessage,
  res: ServerResponse,
  { configStore, cycleTunnel }: Pick<TunnelRoutesDeps, "configStore" | "cycleTunnel">
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  try {
    const previous = configStore.getShimId();
    const shimId = await configStore.regenerateShimId();
    // One shimId names this shim on EVERY tunnel, so every workspace redials.
    const rows = await configStore.listControllers();
    if (rows.length === 1) await cycleTunnel("shim-id-regenerated");
    else for (const row of rows) await cycleTunnel("shim-id-regenerated", row.id);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, previous, shimId }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// POST /internal/tunnel/remove — body { id }. Stops that entry's workspace,
// deletes its storage directory, then removes the entry (D15).
async function handleRemoveTunnel(
  req: IncomingMessage,
  res: ServerResponse,
  { configStore, removeTunnel }: TunnelRoutesDeps
): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  try {
    const id = await optionalId(req);
    if (!id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "missing id" }));
      return;
    }
    if (!(await configStore.getControllerById(id))) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `no controller with id ${id}` }));
      return;
    }
    // Stop the workspace FIRST so nothing writes into the directory, or
    // persists a registration token into the entry, after it is gone.
    await removeTunnel?.(id);
    await configStore.removeController(id);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// An optional `{ id }` body. A missing or empty body is "no id" — the
// pre-Phase-6 routes were called with none.
async function optionalId(req: IncomingMessage): Promise<string | undefined> {
  try {
    const body = await readJsonBody(req) as { id?: unknown } | undefined;
    return body && typeof body.id === "string" && body.id ? body.id : undefined;
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    return undefined;
  }
}

export function createTunnelRoutes(deps: TunnelRoutesDeps) {
  return {
    handleListTunnels: (req: IncomingMessage, res: ServerResponse) =>
      handleListTunnels(req, res, deps),
    handleAddTunnel: (req: IncomingMessage, res: ServerResponse) =>
      handlePostCreds(req, res, deps, "add"),
    handleRemoveTunnel: (req: IncomingMessage, res: ServerResponse) =>
      handleRemoveTunnel(req, res, deps),
    handleGetConfig: (req: IncomingMessage, res: ServerResponse) =>
      handleGetConfig(req, res, deps),
    handlePostCreds: (req: IncomingMessage, res: ServerResponse) =>
      handlePostCreds(req, res, deps),
    handleForceReregister: (req: IncomingMessage, res: ServerResponse) =>
      handleForceReregister(req, res, deps),
    handleRegenerateShimId: (req: IncomingMessage, res: ServerResponse) =>
      handleRegenerateShimId(req, res, deps),
  };
}
