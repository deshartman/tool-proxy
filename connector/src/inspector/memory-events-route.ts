// MEMORY-INJECTION — POST /v1/memory/events. The machine-API sibling of
// POST /v1/outbound/calls (outbound-calls-route.ts): same JWT bearer gate,
// same ControllerApiCoordinator dependency, same machine-api:<clientId>
// audit identity, different controller action (memory.append_event). Closes
// the asymmetry where an enterprise system could trigger a real outbound
// call with nothing but a bearer token but could not inject a memory fact
// the same way — see docs/MEMORY-EVENTS.md.
//
// Three deliberate differences from outbound-calls-route.ts:
//   1. One action, not a map — no ACTION_TO_WIRE, no `action` request field.
//   2. idempotencyKey is pass-through only, never minted. A memory write is
//      low-harm and the controller does not dedup in v1 (docs/MEMORY-EVENTS.md
//      §"Idempotency"), unlike dialing/texting twice.
//   3. No timeout override — memory.append_event is a fast identity-resolve
//      plus memory write, so it inherits the coordinator's 8s default rather
//      than outbound.*'s explicit 30s LLM-turn ceiling.
//
// The optional `type` field selects which memory store the fact lands in
// (episodic / semantic / working). It is forwarded only when the caller asks
// for one — see the note in validateMemoryEventBody for why it isn't defaulted
// connector-side. REQUIRES controller-side support for anything but the
// default; see docs/MEMORY-EVENTS.md §"Memory types".

import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import { verifyAccessToken, type JwtVerifierConfig } from "../auth/jwt.js";
import type { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";

export interface MemoryEventsRouteDeps {
  // Read fresh on every request, not frozen at wiring time — the operator can
  // add/change/clear the trusted-issuer (federated) config live, and it must
  // take effect with no restart. Same read-live-state rationale as
  // getCoordinator below.
  getVerifierConfig: () => Promise<JwtVerifierConfig>;
  // Reads the live coordinator at call time, not at wiring time — a fresh
  // instance is constructed per tunnel dial and dropped to undefined between
  // reconnects (see boot/lifecycle.ts's ControllerApiCoordinator LIFETIME
  // note).
  getCoordinator: () => ControllerApiCoordinator | undefined;
}

const WIRE_ACTION = "memory.append_event";

// The three memory stores a caller can target. Unlike identity.channel (whose
// 9-value enum stays the controller's single source of truth — see
// validateMemoryEventBody), this one IS enumerated connector-side, and the
// asymmetry is deliberate:
//
//   - A bad `channel` fails LOUDLY downstream — the identity simply won't
//     resolve, and the controller answers invalid_params. Nothing is written.
//   - A bad `type` could fail QUIETLY — the write still happens, just into the
//     wrong store (or whatever the controller defaults to), and nobody notices
//     until a recall comes back missing the fact. A local 400 is strictly
//     better than a silently mis-routed write.
//
// Cost of enumerating: a fourth memory type needs a connector release. That's
// the accepted trade for catching a typo'd store name before it writes.
const MEMORY_TYPES = ["episodic", "semantic", "working"] as const;

interface MemoryEventsBody {
  identity?: unknown;
  type?: unknown;
  event?: unknown;
  occurredAt?: unknown;
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
  deps: MemoryEventsRouteDeps,
): Promise<string | undefined> {
  const header = req.headers["authorization"];
  const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  const token = m?.[1]?.trim();
  if (!token) {
    sendJson(res, 401, { error: { code: "not_authorized", message: "missing bearer token" } });
    return undefined;
  }
  const verified = await verifyAccessToken(token, await deps.getVerifierConfig());
  if (!verified.valid || !verified.claims) {
    sendJson(res, 401, { error: { code: "not_authorized", message: verified.error ?? "invalid bearer token" } });
    return undefined;
  }
  return verified.claims.sub;
}

// Presence + type validation only — deliberately NOT the 9-value channel
// enum. `IDENTITY_CHANNEL_KINDS` is the controller's single source of truth;
// duplicating it here would create a second copy to keep in sync, so an
// unknown channel surfaces as the controller's `invalid_params` rather than a
// connector-side `bad_request`. Same thin-connector precedent as
// outbound-calls-route.ts's validateBody, which checks to/agentId/channelId
// for presence only and never their semantics.
//
// Returns the coordinator call's action + params on success. On a bad body it
// writes the 400 itself and returns undefined — same signal shape as the
// outbound route's validateBody, so the caller just early-returns.
//
// Two shape decisions worth knowing before editing:
//   - Strings are trimmed, and the TRIMMED value is what's forwarded. Checking
//     one value and sending another would be the worse of the two options, and
//     edge whitespace isn't meaningful in a channel address or a stored fact.
//     ("stored verbatim" in the contract is about not summarizing/rewriting the
//     fact, not about preserving padding.)
//   - `params` is built field by field rather than spread from the body, so a
//     caller's typo'd or unknown field is dropped here instead of reaching the
//     controller. The cost is that a future controller-side param needs a
//     connector change; that's the intended trade for a validated surface.
// Optional fields follow the repo-wide "empty string == not set" convention
// (see src/env.ts) and are OMITTED entirely when absent — for idempotencyKey
// that's load-bearing, not cosmetic (delta #2: never minted, never sent as a
// present-but-undefined key).
function validateMemoryEventBody(
  body: MemoryEventsBody,
  res: ServerResponse,
): { action: string; params: Record<string, unknown> } | undefined {
  const bad = (message: string): undefined => {
    sendJson(res, 400, { error: { code: "bad_request", message } });
    return undefined;
  };

  const identity = body.identity && typeof body.identity === "object" ? body.identity as Record<string, unknown> : undefined;
  const channel = typeof identity?.channel === "string" ? identity.channel.trim() : "";
  const value = typeof identity?.value === "string" ? identity.value.trim() : "";
  if (!channel || !value) {
    return bad('"identity" must be an object with non-empty string "channel" and "value"');
  }

  const event = typeof body.event === "string" ? body.event.trim() : "";
  if (!event) return bad('"event" must be a non-empty string');

  // Omitted entirely when the caller doesn't ask for one, rather than defaulted
  // to "episodic" here. That keeps this route working against a controller that
  // predates memory-type support: the default case sends the exact same params
  // it always did, and only a caller who explicitly asks for a type sends the
  // new field. The controller owns what "no type" means (episodic today).
  let type: string | undefined;
  if (body.type !== undefined) {
    if (typeof body.type !== "string" || !MEMORY_TYPES.includes(body.type as typeof MEMORY_TYPES[number])) {
      return bad(`"type" must be one of ${MEMORY_TYPES.join(", ")} when present`);
    }
    type = body.type;
  }

  if (body.occurredAt !== undefined && typeof body.occurredAt !== "string") {
    return bad('"occurredAt" must be an ISO 8601 string when present');
  }
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
    return bad('"idempotencyKey" must be a string when present');
  }

  return {
    action: WIRE_ACTION,
    params: {
      identity: { channel, value },
      event,
      ...(type ? { type } : {}),
      ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    },
  };
}

export async function handleMemoryEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MemoryEventsRouteDeps,
): Promise<void> {
  const clientId = await authenticate(req, res, deps);
  if (!clientId) return;

  let body: MemoryEventsBody;
  try {
    body = (await readJsonBody(req) as MemoryEventsBody) ?? {};
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: { code: "payload_too_large", message: "payload too large" } });
      return;
    }
    sendJson(res, 400, { error: { code: "bad_request", message: "malformed body" } });
    return;
  }

  const validated = validateMemoryEventBody(body, res);
  if (!validated) return;

  const coordinator = deps.getCoordinator();
  if (!coordinator) {
    sendJson(res, 503, { error: { code: "tunnel_unavailable", message: "no tunnel connected" } });
    return;
  }

  try {
    // No timeoutMs (delta #3) — inherits the coordinator's 8s default.
    const result = await coordinator.call(`machine-api:${clientId}`, undefined, validated.action, validated.params);
    sendJson(res, 200, { result });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "controller_error";
    const message = (err as Error)?.message ?? String(err);
    sendJson(res, code === "tunnel_unavailable" ? 503 : 502, { error: { code, message } });
  }
}

export function createMemoryEventsRoute(deps: MemoryEventsRouteDeps) {
  return { handle: (req: IncomingMessage, res: ServerResponse) => handleMemoryEvents(req, res, deps) };
}
