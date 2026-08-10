// CONNECTOR-NETWORK-EXPOSURE — inspector routes for machine-API client
// management. Mirrors tunnel-routes.ts's shape: a deps object threaded in
// from boot/lifecycle.ts, one exported factory returning bound handlers,
// guardCsrf on every state-changing POST. All of these routes are
// operator actions reached from the SAME trusted loopback session as
// Configure Tunnel — there is no separate admin login. Adding the first
// API client is what turns on non-loopback reachability for the machine
// API (POST /oauth/token) — see handleAddClient below.

import type { IncomingMessage, ServerResponse } from "node:http";
import { guardCsrf } from "./server.js";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import type { ConfigStore } from "../config-store/index.js";

interface NetworkAccessRoutesDeps {
  configStore: ConfigStore;
  // Live-rebinds the inspector's HTTP listener from loopback to reachable-
  // from-elsewhere, in-process. Called once, the first time an API client
  // is added; a no-op if the listener is already non-loopback.
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

// GET /internal/network-access/status
async function handleStatus(_req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  setJsonHeaders(res);
  const state = await deps.configStore.getNetworkAccessState();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, ...state }));
}

// POST /internal/network-access/clients — "Add API client". Body: { name? }
// The FIRST client ever added flips network_access.enabled on and live-
// rebinds the listener non-loopback — no separate "Enable" step. Every
// subsequent add is a no-op on that front (setNetworkAccessEnabled(true)
// and rebindNonLoopback() are both idempotent).
async function handleAddClient(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const name = typeof body.name === "string" && body.name ? body.name : undefined;
  const { clientId, clientSecret } = await deps.configStore.mintApiClient(name);
  const wasEnabled = (await deps.configStore.getNetworkAccessState()).enabled;
  if (!wasEnabled) await deps.configStore.setNetworkAccessEnabled(true);
  res.statusCode = 200;
  // Rebind AFTER the response has actually been flushed — rebindNonLoopback()
  // force-closes existing connections to make the close()+relisten prompt,
  // and the socket carrying THIS response is one of them. Doing it before
  // res.end() finishes writing raced the client into ERR_EMPTY_RESPONSE
  // (caught live via the inspector UI's own "Add API client" click).
  if (!wasEnabled) res.on("finish", () => deps.rebindNonLoopback());
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

// POST /internal/network-access/clients/revoke — "Revoke" (soft — blocks
// future /oauth/token attempts, row stays visible with a revoked-at
// timestamp). Body: { clientId }
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

// POST /internal/network-access/clients/delete — "Delete" (hard — removes
// the row entirely). Only reachable in the UI after Revoke, and enforced
// server-side too: ConfigStore.deleteApiClient refuses a still-active
// client_id. Body: { clientId }
async function handleDeleteClient(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const deleted = clientId ? await deps.configStore.deleteApiClient(clientId) : false;
  if (!deleted) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "unknown client_id, or client is not yet revoked" }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}

// ─── Federated JWT trust config ───────────────────────────────────────────
// FEDERATED-JWT-MODE — three handlers folded in alongside API-client
// management (same deps, same trust tier, one wiring call site). Federated
// mode has no per-client allowlist: any JWT signed by the configured trusted
// issuer, with the right audience, not expired, is accepted. Client lifecycle
// is entirely the customer's own IdP's responsibility.

// GET /internal/network-access/trusted-issuer. No redaction — nothing secret.
async function handleGetTrustedIssuer(_req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  setJsonHeaders(res);
  const config = await deps.configStore.getTrustedIssuerConfig();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, config: config ?? null }));
}

// POST /internal/network-access/trusted-issuer — body { issuer, jwksUrl,
// audience } (all three required, non-empty strings). Setting a config for
// the FIRST time — when no self-issued API client has ever flipped it — also
// flips network_access.enabled on and live-rebinds the listener non-loopback,
// mirroring handleAddClient. Without it a customer who configures ONLY
// federated mode (never adds an API client) would leave /v1/outbound/calls
// unreachable non-loopback even with a fully valid federated JWT.
async function handleSetTrustedIssuer(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  const body = await readBody(req, res);
  if (!body) return;
  const issuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
  const jwksUrl = typeof body.jwksUrl === "string" ? body.jwksUrl.trim() : "";
  const audience = typeof body.audience === "string" ? body.audience.trim() : "";
  if (!issuer || !jwksUrl || !audience) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "issuer, jwksUrl, and audience are all required" }));
    return;
  }
  await deps.configStore.setTrustedIssuerConfig({ issuer, jwksUrl, audience });
  const wasEnabled = (await deps.configStore.getNetworkAccessState()).enabled;
  if (!wasEnabled) await deps.configStore.setNetworkAccessEnabled(true);
  res.statusCode = 200;
  // Rebind AFTER the response has flushed — same ordering as handleAddClient;
  // rebindNonLoopback() force-closes existing connections (including the one
  // carrying this response), and doing it before res.end() finishes writing
  // races the client into ERR_EMPTY_RESPONSE.
  if (!wasEnabled) res.on("finish", () => deps.rebindNonLoopback());
  res.end(JSON.stringify({ ok: true }));
}

// POST /internal/network-access/trusted-issuer/clear. Does NOT un-rebind or
// flip network_access.enabled back to false — matches this feature's one-way-
// widening semantics everywhere else (revoking an API client doesn't
// re-narrow the bind either).
async function handleClearTrustedIssuer(req: IncomingMessage, res: ServerResponse, deps: NetworkAccessRoutesDeps): Promise<void> {
  if (!guardCsrf(req, res)) return;
  setJsonHeaders(res);
  await deps.configStore.clearTrustedIssuerConfig();
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}

export function createNetworkAccessRoutes(deps: NetworkAccessRoutesDeps) {
  return {
    handleStatus: (req: IncomingMessage, res: ServerResponse) => handleStatus(req, res, deps),
    handleAddClient: (req: IncomingMessage, res: ServerResponse) => handleAddClient(req, res, deps),
    handleListClients: (req: IncomingMessage, res: ServerResponse) => handleListClients(req, res, deps),
    handleRevokeClient: (req: IncomingMessage, res: ServerResponse) => handleRevokeClient(req, res, deps),
    handleDeleteClient: (req: IncomingMessage, res: ServerResponse) => handleDeleteClient(req, res, deps),
    handleGetTrustedIssuer: (req: IncomingMessage, res: ServerResponse) => handleGetTrustedIssuer(req, res, deps),
    handleSetTrustedIssuer: (req: IncomingMessage, res: ServerResponse) => handleSetTrustedIssuer(req, res, deps),
    handleClearTrustedIssuer: (req: IncomingMessage, res: ServerResponse) => handleClearTrustedIssuer(req, res, deps),
  };
}

export type NetworkAccessRoutes = ReturnType<typeof createNetworkAccessRoutes>;
