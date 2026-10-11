// CONNECTOR-NETWORK-EXPOSURE step 9 — POST /v1/outbound/calls. The one
// machine-API route with a real dependency on ControllerApiCoordinator (see
// the network-access design; see docs/NETWORK-ACCESS.md). Gated by
// the same JWT bearer the machine API mints via /oauth/token — no loopback
// requirement, no MCP identity, no isAuthorTwilio check. The controller
// derives its own trust from the authenticated WS session; this route's own
// job is only verifying the caller's bearer token before ever touching the
// tunnel.
//
// Reuses ControllerCallFrame's `mcp` field (normally a bundled MCP's
// ServerDescriptor.name, used for the controller's audit trail) to carry
// `machine-api:<clientId>` instead — the JWT's `sub` claim — so the
// controller can still distinguish which machine caller triggered the
// action, with no wire-protocol change. See docs/MCP-PROTOCOL.md §"v1.4 —
// Controller API calls" for the frame contract this rides on.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import { verifyAccessToken, type AccessTokenClaims, type JwtVerifierConfig } from "../auth/jwt.js";
import type { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";

export interface OutboundCallsRouteDeps {
  // Read fresh on every request, not frozen at wiring time — the operator can
  // add/change/clear the trusted-issuer (federated) config live, and it must
  // take effect with no restart. Same read-live-state rationale as
  // getCoordinator below (see FEDERATED-JWT-MODE.md §4).
  getVerifierConfig: (token: string) => Promise<JwtVerifierConfig>;
  // Reads the live coordinator at call time, not at wiring time — a fresh
  // instance is constructed per tunnel dial and dropped to undefined between
  // reconnects (see boot/lifecycle.ts's ControllerApiCoordinator LIFETIME
  // note). This route must observe that liveness the same way
  // mcpActions.callControllerApi already does.
  // Phase 6 (§5.6): the verified claims select the workspace — a self-issued
  // token's `sub` names a client bound to one controller entry, a federated
  // token's `iss` + `aud` name the entry that trusts it. Undefined when that
  // workspace has no live tunnel, or the credential is bound to none.
  getCoordinator: (claims: AccessTokenClaims) => ControllerApiCoordinator | undefined | Promise<ControllerApiCoordinator | undefined>;
}

const ACTION_TO_WIRE: Record<string, string> = {
  place_call: "outbound.place_call",
  send_message: "outbound.send_message",
};

// Both outbound.* actions run a synchronous LLM turn on the controller side
// before answering — see docs/OUTBOUND-CALLS.md §6's tool_timeout_ms note.
// This route isn't wrapped by the connector's own policy.tool_timeout_ms (it
// doesn't go through a tool call at all), so the only ceiling that matters is
// this one, passed straight to the coordinator.
const OUTBOUND_TIMEOUT_MS = 30_000;

interface OutboundCallsBody {
  action?: unknown;
  to?: unknown;
  agentId?: unknown;
  channelId?: unknown;
  callContext?: unknown;
  idempotencyKey?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OutboundCallsRouteDeps,
): Promise<AccessTokenClaims | undefined> {
  const header = req.headers["authorization"];
  const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  const token = m?.[1]?.trim();
  if (!token) {
    sendJson(res, 401, { error: { code: "not_authorized", message: "missing bearer token" } });
    return undefined;
  }
  const verified = await verifyAccessToken(token, await deps.getVerifierConfig(token));
  if (!verified.valid || !verified.claims) {
    sendJson(res, 401, { error: { code: "not_authorized", message: verified.error ?? "invalid bearer token" } });
    return undefined;
  }
  return verified.claims;
}

function validateBody(body: OutboundCallsBody, res: ServerResponse): { action: string; params: Record<string, unknown> } | undefined {
  const action = typeof body.action === "string" ? body.action : undefined;
  const wireAction = action ? ACTION_TO_WIRE[action] : undefined;
  if (!wireAction) {
    sendJson(res, 400, { error: { code: "bad_request", message: 'action must be "place_call" or "send_message"' } });
    return undefined;
  }
  const to = typeof body.to === "string" ? body.to : undefined;
  const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
  const channelId = typeof body.channelId === "string" ? body.channelId : undefined;
  if (!to || !agentId || !channelId) {
    sendJson(res, 400, { error: { code: "bad_request", message: 'missing "to", "agentId", or "channelId"' } });
    return undefined;
  }
  const callContext = body.callContext && typeof body.callContext === "object" ? body.callContext : undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : randomUUID();

  return {
    action: wireAction,
    params: { to, agentId, channelId, idempotencyKey, ...(callContext ? { callContext } : {}) },
  };
}

export async function handleOutboundCalls(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OutboundCallsRouteDeps,
): Promise<void> {
  const claims = await authenticate(req, res, deps);
  if (!claims) return;
  const clientId = claims.sub;

  let body: OutboundCallsBody;
  try {
    body = (await readJsonBody(req) as OutboundCallsBody) ?? {};
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: { code: "payload_too_large", message: "payload too large" } });
      return;
    }
    sendJson(res, 400, { error: { code: "bad_request", message: "malformed body" } });
    return;
  }

  const validated = validateBody(body, res);
  if (!validated) return;

  const coordinator = await deps.getCoordinator(claims);
  if (!coordinator) {
    sendJson(res, 503, { error: { code: "tunnel_unavailable", message: "no tunnel connected" } });
    return;
  }

  try {
    const result = await coordinator.call(`machine-api:${clientId}`, undefined, validated.action, validated.params, OUTBOUND_TIMEOUT_MS);
    sendJson(res, 200, { result });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "controller_error";
    const message = (err as Error)?.message ?? String(err);
    sendJson(res, code === "tunnel_unavailable" ? 503 : 502, { error: { code, message } });
  }
}

export function createOutboundCallsRoute(deps: OutboundCallsRouteDeps) {
  return { handle: (req: IncomingMessage, res: ServerResponse) => handleOutboundCalls(req, res, deps) };
}
