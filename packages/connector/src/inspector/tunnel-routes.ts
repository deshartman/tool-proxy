// Tunnel routes for inspector — DB mode only (env mode returns 404)
// These routes are only wired when bootFromDb is active; they allow
// operators to configure, edit, and force re-registration of the
// controller tunnel via the localhost inspector UI.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore, ControllerInput, ControllerRow } from "../config-store/index.js";

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
  dialTunnel: (row: ControllerRow) => Promise<void>;
  cycleTunnel: (reason: string) => Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("malformed JSON");
  }
}

function setJsonHeaders(res: ServerResponse): void {
  res.setHeader("content-type", "application/json");
}

// GET /internal/tunnel/config
async function handleGetConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  { configStore }: Pick<TunnelRoutesDeps, "configStore">
): Promise<void> {
  try {
    const row = await configStore.getController();
    setJsonHeaders(res);
    if (!row) {
      res.statusCode = 200;
      res.end(JSON.stringify({ configured: false }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, row: rowToSummary(row) }));
  } catch (err) {
    setJsonHeaders(res);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// POST /internal/tunnel/creds
// Body: ControllerInput-shaped JSON
async function handlePostCreds(
  req: IncomingMessage,
  res: ServerResponse,
  { configStore }: Pick<TunnelRoutesDeps, "configStore">
): Promise<void> {
  setJsonHeaders(res);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
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

  // Validate required fields
  const name = typeof b.name === "string" ? b.name : undefined;
  const controllerUrl = typeof b.controllerUrl === "string" ? b.controllerUrl : undefined;
  const connectorName = typeof b.connectorName === "string" ? b.connectorName : undefined;
  const environment = b.environment === null || typeof b.environment === "string" ? b.environment : undefined;
  const authMode = b.authMode === "static-bearer" || b.authMode === "oauth2-cc" ? b.authMode : undefined;

  if (!name || !controllerUrl || !connectorName || !authMode) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      ok: false,
      error: "missing required fields: name, controllerUrl, connectorName, authMode"
    }));
    return;
  }

  // Build ControllerInput
  const input: ControllerInput = {
    name,
    controllerUrl,
    connectorName,
    environment: environment ?? null,
    authMode,
  };

  if (authMode === "static-bearer") {
    const token = typeof b.tunnelAuthToken === "string" ? b.tunnelAuthToken : undefined;
    if (!token) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "tunnelAuthToken is required when authMode is static-bearer" }));
      return;
    }
    input.tunnelAuthToken = token;
  } else {
    const clientId = typeof b.oauthClientId === "string" ? b.oauthClientId : undefined;
    const clientSecret = typeof b.oauthClientSecret === "string" ? b.oauthClientSecret : undefined;
    const tokenUrl = typeof b.oauthTokenUrl === "string" ? b.oauthTokenUrl : undefined;
    if (!clientId || !clientSecret || !tokenUrl) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        ok: false,
        error: "oauthClientId, oauthClientSecret, and oauthTokenUrl are required when authMode is oauth2-cc"
      }));
      return;
    }
    input.oauthClientId = clientId;
    input.oauthClientSecret = clientSecret;
    input.oauthTokenUrl = tokenUrl;
  }

  try {
    await configStore.upsertController(input);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

// POST /internal/tunnel/force-reregister
async function handleForceReregister(
  _req: IncomingMessage,
  res: ServerResponse,
  { configStore, cycleTunnel }: Pick<TunnelRoutesDeps, "configStore" | "cycleTunnel">
): Promise<void> {
  setJsonHeaders(res);

  try {
    const row = await configStore.getController();
    if (!row) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: "no controller row configured" }));
      return;
    }

    await configStore.clearRegistrationToken(row.id);
    await cycleTunnel("force-reregister");

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

export function createTunnelRoutes(deps: TunnelRoutesDeps) {
  return {
    handleGetConfig: (req: IncomingMessage, res: ServerResponse) =>
      handleGetConfig(req, res, deps),
    handlePostCreds: (req: IncomingMessage, res: ServerResponse) =>
      handlePostCreds(req, res, deps),
    handleForceReregister: (req: IncomingMessage, res: ServerResponse) =>
      handleForceReregister(req, res, deps),
  };
}
