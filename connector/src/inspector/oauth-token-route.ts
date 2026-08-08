// CONNECTOR-NETWORK-EXPOSURE — POST /oauth/token. Self-issued
// client_credentials grant (RFC 6749 §4.4) for the machine API. No admin
// session, no CSRF guard — the caller is a machine presenting its own
// client_id/client_secret, not a browser. Reachable at all only once the
// inspector is bound non-loopback (same gate as every other route on this
// server — see PUBLIC_PATHS in server.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readUrlEncodedBody } from "./read-body.js";
import type { ConfigStore } from "../config-store/index.js";
import { signHs256 } from "../auth/jwt.js";

export interface OauthTokenRouteDeps {
  configStore: ConfigStore;
  signingKey: Buffer;
  expiresInSec: number;
}

// RFC 6749 §5.2 — error shape a standard OAuth2 client library parses.
// Unknown client_id and wrong-secret-for-a-known-client_id return the
// IDENTICAL body; the two cases must not be distinguishable from the
// response (see ConfigStore.verifyApiClient).
function invalidClient(res: ServerResponse, description: string): void {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "invalid_client", error_description: description }));
}

export async function handleOauthToken(req: IncomingMessage, res: ServerResponse, deps: OauthTokenRouteDeps): Promise<void> {
  let params: URLSearchParams;
  try {
    params = await readUrlEncodedBody(req);
  } catch (error) {
    res.statusCode = error instanceof BodyTooLargeError ? 413 : 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_request", error_description: "malformed body" }));
    return;
  }

  const grantType = params.get("grant_type");
  if (grantType !== "client_credentials") {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unsupported_grant_type" }));
    return;
  }

  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  if (!clientId || !clientSecret) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_request", error_description: "client_id and client_secret are required" }));
    return;
  }

  const valid = await deps.configStore.verifyApiClient(clientId, clientSecret);
  if (!valid) {
    invalidClient(res, "unknown client_id or incorrect client_secret");
    return;
  }

  const accessToken = signHs256({ sub: clientId }, deps.signingKey, deps.expiresInSec);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: deps.expiresInSec }));
}
