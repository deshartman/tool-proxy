// MEMORY-INJECTION — POST /v1/memory/events. The machine-API sibling of
// POST /v1/outbound/calls (outbound-calls-route.ts): same JWT bearer gate,
// same ControllerApiCoordinator dependency, same machine-api:<clientId>
// audit identity, different controller action (memory.inject_context). Closes
// the asymmetry where an enterprise system could trigger a real outbound
// call with nothing but a bearer token but could not inject a memory fact
// the same way — see docs/MEMORY-EVENTS.md.
//
// Three deliberate differences from outbound-calls-route.ts:
//   1. One action, not a map — no ACTION_TO_WIRE, no `action` request field.
//   2. idempotencyKey is pass-through only, never minted. A memory write is
//      low-harm and the controller does not dedup in v1 (docs/MEMORY-EVENTS.md
//      §"Idempotency"), unlike dialing/texting twice.
//   3. No timeout override — memory.inject_context is a fast identity-resolve
//      plus row write with no LLM turn, so it inherits the coordinator's 8s
//      default rather than outbound.*'s explicit 30s LLM-turn ceiling.
//
// The write lands in the agent's WORKING memory, which is keyed
// (accountId, agentId, identityKey) — hence `agentId` is required alongside
// `identityId`. There is no memory-tier selector: working is the only tier this
// action writes (episodic rows are authored by the controller's summariser at
// flush time, not hand-written; the semantic tier was retired controller-side).
// A `type` field existed briefly here and was cancelled outright, not deferred.
//
// THIS ROUTE DOES NOT ACCEPT AN ADDRESS. `identityId` is an opaque controller
// handle obtained from POST /v1/identity/list (identity-routes.ts) — injection
// is the second half of a resolve-then-write flow. Two earlier shapes are both
// retired: a nested `identity: { channel, value }` pair, then a flat `customer`
// string the controller resolved internally. That internal resolve was
// find-or-CREATE, so a typo'd digit minted a phantom identity with a real
// working-memory row hanging off it, let an external caller grow the identity
// table at will, and failed silently — the mistyped write "succeeded" and
// nobody learned otherwise until the agent said nothing on the call. Splitting
// resolution out makes lookup read-only and an unknown customer a `null` answer
// up front. Do NOT reintroduce address-shaped input here as a convenience.
//
// Still no `channelId`: working memory is wire-blind, one row per
// (agent, identity) regardless of channel, so a fact injected before an SMS is
// visible on a later voice call for free.

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

const WIRE_ACTION = "memory.inject_context";

interface MemoryEventsBody {
  agentId?: unknown;
  identityId?: unknown;
  event?: unknown;
  occurredAt?: unknown;
  ttlSeconds?: unknown;
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

// Presence + type validation only. `identityId` and `agentId` are checked for
// being non-empty strings and nothing more — whether either resolves, and
// whether both belong to this tunnel session's account, is the controller's
// call (it answers `cross_account`, not `invalid_params`, for a foreign or
// merged handle). Same thin-connector precedent as outbound-calls-route.ts's
// validateBody, which checks to/agentId/channelId for presence only and never
// their semantics.
//
// Returns the coordinator call's action + params on success. On a bad body it
// writes the 400 itself and returns undefined — same signal shape as the
// outbound route's validateBody, so the caller just early-returns.
//
// Two shape decisions worth knowing before editing:
//   - Strings are trimmed, and the TRIMMED value is what's forwarded. Checking
//     one value and sending another would be the worse of the two options, and
//     edge whitespace isn't meaningful in an opaque id or in a fact.
//     ("stored verbatim" in the contract is about not summarizing/rewriting the
//     fact, not about preserving padding.)
//   - `params` is built field by field rather than spread from the body, so a
//     caller's typo'd or unknown field never reaches the controller. The cost is
//     that a future controller-side param needs a connector change; that's the
//     intended trade for a validated surface. Because of that, unknown top-level
//     keys are REJECTED here rather than silently dropped — the controller's own
//     schema is `.strict()` for the same reason, and silently swallowing a key
//     the caller believes is doing something is the failure mode both sides are
//     trying to avoid. Concretely: a caller still sending the cancelled `type`
//     field gets told so, instead of a 200 that ignored it.
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

  const KNOWN_FIELDS = ["agentId", "identityId", "event", "occurredAt", "ttlSeconds", "idempotencyKey"];
  const unknown = Object.keys(body).filter((k) => !KNOWN_FIELDS.includes(k));
  if (unknown.length > 0) {
    return bad(`unknown field(s): ${unknown.join(", ")} — allowed: ${KNOWN_FIELDS.join(", ")}`);
  }

  // Presence only, never semantics — the controller resolves the agent through
  // an account-scoped lookup and answers `cross_account` if it belongs to
  // another account. Same treatment outbound-calls-route.ts gives its own
  // agentId. Required, not optional: working memory is keyed
  // (accountId, agentId, identityKey), so there is no way to write it without
  // naming an agent.
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) return bad('"agentId" must be a non-empty string');

  // An opaque controller handle from POST /v1/identity/list, NOT an address.
  // Deliberately not pattern-checked: the format is the controller's to change,
  // and a connector-side guess at what an id looks like would reject valid
  // handles the day that format moves.
  const identityId = typeof body.identityId === "string" ? body.identityId.trim() : "";
  if (!identityId) {
    return bad('"identityId" must be a non-empty string — resolve one via POST /v1/identity/list (this route does not accept a phone number or email address)');
  }

  const event = typeof body.event === "string" ? body.event.trim() : "";
  if (!event) return bad('"event" must be a non-empty string');

  if (body.occurredAt !== undefined && typeof body.occurredAt !== "string") {
    return bad('"occurredAt" must be an ISO 8601 string when present');
  }
  // Type-only, deliberately NOT range-checked here — but note that "forwarded"
  // does NOT mean "accepted". The controller owns the whole range policy and it
  // is asymmetric: it defaults 600s, CLAMPS anything above 86400s (reporting the
  // post-clamp truth as `expiresAt`), and REJECTS 0, negatives, and fractional
  // values outright with `invalid_params`. This route can't usefully predict
  // which of those three a given number will hit, and duplicating the rule would
  // mean a connector-side 400 for values the controller would have clamped, plus
  // a second copy to drift. Same reason this route never validated address
  // shapes: one owner per rule.
  if (body.ttlSeconds !== undefined && (typeof body.ttlSeconds !== "number" || !Number.isFinite(body.ttlSeconds))) {
    return bad('"ttlSeconds" must be a finite number when present');
  }
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
    return bad('"idempotencyKey" must be a string when present');
  }

  return {
    action: WIRE_ACTION,
    params: {
      agentId,
      identityId,
      event,
      ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
      // Guarded on `!== undefined`, not truthiness — and that distinction is
      // load-bearing. The controller REJECTS `ttlSeconds: 0` with
      // `invalid_params`; a truthiness guard would drop the 0, silently
      // substituting the 600s default and telling the caller nothing. Forwarding
      // it is what makes them find out they asked for something invalid.
      ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
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
