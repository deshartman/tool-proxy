// CONNECTOR-NETWORK-EXPOSURE — inspector routes for the admin login flow
// and the machine-API "Add API client" action. Mirrors tunnel-routes.ts's
// shape: a deps object threaded in from boot/lifecycle.ts, one exported
// factory returning bound handlers, guardCsrf on every state-changing POST.

import type { IncomingMessage, ServerResponse } from "node:http";
import { guardCsrf } from "./server.js";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import type { ConfigStore } from "../config-store/index.js";
import type { AdminSessionStore } from "./network-access.js";

interface NetworkAccessRoutesDeps {
  configStore: ConfigStore;
  sessions: AdminSessionStore;
  // Live-rebinds the inspector's HTTP listener from loopback to the
  // configured non-loopback bind address, in-process. Called once, from
  // the "enable" handler; a no-op if the listener is already non-loopback
  // (re-clicking "Enable network access" after it's already on).
  rebindNonLoopback: () => void;
}

function setJsonHeaders(res: ServerResponse): void {
  res.setHeader("content-type", "application/json");
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "body must be an object" }));
      return undefined;
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      res.statusCode = 413;
      res.end(JSON.stringify({ ok: false, error: "payload too large" }));
      return undefined;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "malformed JSON body" }));
    return undefined;
  }
}

// POST /internal/network-access/login — body: { secret }
// No prior session required (that would be circular) — this route mints
// the session. Reachable from non-loopback ONLY once network access is
// already enabled (otherwise the bind is loopback-only and nothing off-box
// can reach this route at all).
async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const secret = typeof body.secret === "string" ? body.secret : "";
  const valid = await deps.configStore.verifyAdminSecret(secret);
  if (!valid) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "invalid secret" }));
    return;
  }
  const token = deps.sessions.mint();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, token }));
}

// POST /internal/network-access/enable — the one-click atomic action from
// the plan: mint-if-absent, persist enabled=true, reveal the plaintext once
// (only when freshly minted this call), then live-rebind the listener.
async function handleEnable(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const before = await deps.configStore.getNetworkAccessState();
  const { plaintext } = await deps.configStore.mintAdminSecret();
  await deps.configStore.setNetworkAccessEnabled(true);
  res.statusCode = 200;
  // Rebind AFTER the response has actually been flushed to the client —
  // rebindNonLoopback() force-closes existing connections
  // (closeAllConnections()) to make the close()+relisten prompt, and the
  // socket carrying THIS very response is one of them. Doing it before
  // res.end() finishes writing raced the client into ERR_EMPTY_RESPONSE
  // (caught live via the inspector UI's own "Enable network access" click).
  res.on("finish", () => deps.rebindNonLoopback());
  res.end(JSON.stringify({ ok: true, secret: plaintext, alreadyEnabled: before.enabled }));
}

// POST /internal/network-access/rotate — always mints a new secret and
// shows it once. Does not touch already-issued sessions (rotating the
// login credential doesn't need to log out sessions already established).
async function handleRotate(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const secret = await deps.configStore.rotateAdminSecret();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, secret }));
}

// GET /internal/network-access/status
async function handleStatus(_req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  setJsonHeaders(res);
  const state = await deps.configStore.getNetworkAccessState();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, ...state }));
}

// POST /internal/network-access/clients — "Add API client". Body: { name? }
async function handleAddClient(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const name = typeof body.name === "string" && body.name ? body.name : undefined;
  const { clientId, clientSecret } = await deps.configStore.mintApiClient(name);
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, clientId, clientSecret }));
}

// GET /internal/network-access/clients — never returns secrets.
async function handleListClients(_req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  setJsonHeaders(res);
  const clients = await deps.configStore.listApiClients();
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    clients: clients.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      createdAt: c.createdAt.toISOString(),
      revokedAt: c.revokedAt?.toISOString() ?? null,
    })),
  }));
}

// POST /internal/network-access/clients/revoke — "Remove API client".
// Body: { clientId }
async function handleRevokeClient(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const revoked = clientId ? await deps.configStore.revokeApiClient(clientId) : false;
  if (!revoked) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "unknown or already-revoked client_id" }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}

export function createNetworkAccessRoutes(deps: NetworkAccessRoutesDeps) {
  return {
    handleLogin: (req: IncomingMessage, res: ServerResponse) => handleLogin(req, res, deps),
    handleEnable: (req: IncomingMessage, res: ServerResponse) => handleEnable(req, res, deps),
    handleRotate: (req: IncomingMessage, res: ServerResponse) => handleRotate(req, res, deps),
    handleStatus: (req: IncomingMessage, res: ServerResponse) => handleStatus(req, res, deps),
    handleAddClient: (req: IncomingMessage, res: ServerResponse) => handleAddClient(req, res, deps),
    handleListClients: (req: IncomingMessage, res: ServerResponse) => handleListClients(req, res, deps),
    handleRevokeClient: (req: IncomingMessage, res: ServerResponse) => handleRevokeClient(req, res, deps),
  };
}

export type NetworkAccessRoutes = ReturnType<typeof createNetworkAccessRoutes>;
