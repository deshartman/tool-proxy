// MEMORY-INJECTION (2026-08-12 contract change) — POST /v1/identity/find and
// POST /v1/identity/list. The resolve half of memory injection's
// resolve-then-write flow:
//
//   1. POST /v1/identity/find  -> identityId (or null)
//   2. POST /v1/memory/events  -> write the fact (memory-events-route.ts)
//   3. POST /v1/outbound/calls -> place the call, or just wait for inbound
//
// Both are machine-API routes with the same JWT bearer gate, the same
// ControllerApiCoordinator dependency, and the same machine-api:<clientId>
// audit identity as the other two /v1/* routes. See docs/MEMORY-EVENTS.md §2.
//
// WHY THESE EXIST AT ALL. /v1/memory/events used to take an address
// (`customer: "+1555..."`) and let the controller resolve it. That resolve was
// find-or-CREATE, which made three failure modes structural: a typo minted a
// phantom identity (and let an external caller grow the identity table at
// will); an opaque webchat session UID could not be expressed, because only
// phones and emails are self-describing by shape, so the handler had to reject
// everything else; and a mistyped address "succeeded", with nobody finding out
// until the agent failed to mention the fact on the call. Lookup-only
// resolution fixes all three at once.
//
// TWO CALLER-VISIBLE SHARP EDGES, both deliberate on the controller side:
//
//   - `identity: null` from /find is a NORMAL 200, not a 404 and not an error.
//     It means "we have no record of this customer", which is a legitimate
//     state with a correct alternative: place the call with the fact in
//     `callContext` instead, since there's no conversation history to prepend
//     to. This route does NOT translate null into an HTTP error status — doing
//     so would push callers toward logging-and-dropping a normal answer.
//   - /list has no server-side cap and no cursor. Omitting `limit` returns the
//     account's entire identity set. The controller rejected capping at 100
//     because a silent truncation is indistinguishable from "that's all of
//     them", whereas an unbounded call can be slow but cannot lie. The binding
//     constraint is therefore THIS ROUTE'S TIMEOUT, not response size (the
//     tunnel WS takes ws's 100 MiB default maxPayload), and a timeout yields
//     nothing rather than a partial — hence the higher default plus the
//     caller-settable override below.
//
// DO NOT ADD A RETRY ON /list TIMEOUT. There is no cancellation path: when our
// window elapses we stop waiting, but the controller's query runs to completion
// and its reply lands on a requestId the coordinator has already discarded. A
// retry loop therefore stacks abandoned full-account scans on the controller,
// each still executing, while the caller sees only failures. The correct
// response to a timeout is to surface it and tell the caller to raise
// `timeoutMs` (or narrow with `match`/`channel`) — which is what the 502
// passthrough plus the demo driver's error hint do. This is also why the
// coordinator itself never auto-retries any action.
//
// PRIVACY NOTE, worth knowing before adding more read routes: /list is the
// first machine-API route that returns bulk customer PII (every alias value on
// every identity in the account) rather than performing one targeted action.
// The gate is identical to the other /v1/* routes — a valid bearer, account
// scoping enforced controller-side — but the blast radius of a leaked bearer is
// now "enumerate the customer base", not just "dial or inject".
//
// This is NOT an argument for making /list loopback-only. It's a remote API call
// by design — an external system browsing the account is the use case, and the
// lever that actually fits the risk is credential scoping (bearers are
// per-API-client and revocable), not route placement. Narrowing the bind would
// break the feature for every caller to mitigate "who holds a credential".
// Enumeration is also detectable rather than silent: the controller's audit rows
// carry the returned row count, so a bearer sweeping the account leaves a
// visible trail.

import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import { verifyAccessToken, type JwtVerifierConfig } from "../auth/jwt.js";
import type { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";

export interface IdentityRoutesDeps {
  // Both read live state per request, never frozen at wiring time — same
  // rationale as the outbound and memory routes: the operator can set/clear the
  // federated trusted-issuer config without a restart, and the coordinator is
  // rebuilt per tunnel dial (undefined between reconnects).
  getVerifierConfig: () => Promise<JwtVerifierConfig>;
  getCoordinator: () => ControllerApiCoordinator | undefined;
}

const FIND_ACTION = "identity.find";
const LIST_ACTION = "identity.list";

// The controller requires `channel` on find and will NOT derive it: its
// normalisation is kind-aware (lowercase for email, trim-only for phone and
// webchat-uid), so an exact lookup is impossible without knowing the kind.
// Deriving it from the string shape is exactly what the retired `customer`
// field did, and is why webchat UIDs were unreachable.
//
// Enumerated here rather than passed through opaquely, unlike every other field
// on these routes. Three reasons it earns the coupling: the field is REQUIRED,
// so a missing value has to be caught locally anyway; the set is closed and
// small; and `test-harness` is a plausible caller guess that the controller
// explicitly REFUSES on input (it's a controller-internal construct that can
// still appear in a returned `aliases` array), so naming the valid set locally
// turns an opaque `invalid_params` round trip into a precise 400. The cost is
// real and accepted: a channel kind added controller-side needs a connector
// bump before callers can use it.
const IDENTITY_CHANNELS = ["phone", "email", "webchat-uid"] as const;

// identity.find is an exact single-row lookup — the coordinator's 8s default is
// plenty, so this route passes no override.
//
// identity.list can walk the account's entire identity set, so it defaults
// higher (matching outbound.*'s 30s, rather than inventing a third number) and
// accepts a caller override. The override exists because the connector cannot
// know how large a customer's account is, and without it a large-account caller
// has no recourse from here at all short of a connector code change. Clamped at
// both ends: a pending call holds a coordinator map entry plus a timer, and the
// inspector's HTTP server runs with requestTimeout = 0, so there is no other
// backstop on how long one caller can hold a request open.
const LIST_DEFAULT_TIMEOUT_MS = 30_000;
const LIST_MIN_TIMEOUT_MS = 1_000;
const LIST_MAX_TIMEOUT_MS = 120_000;

interface IdentityFindBody {
  identifier?: unknown;
  channel?: unknown;
}

interface IdentityListBody {
  match?: unknown;
  channel?: unknown;
  limit?: unknown;
  timeoutMs?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Same bearer gate as outbound-calls-route.ts and memory-events-route.ts. This
// is the third verbatim copy; extracting a shared helper would touch both
// existing routes, which is out of scope for this contract change. Both find
// and list share this one copy rather than adding a fourth.
async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
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

// Shared body read. Returns undefined after writing its own 4xx, same signal
// shape the validators use, so callers just early-return.
async function readBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    return ((await readJsonBody(req)) as T) ?? ({} as T);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: { code: "payload_too_large", message: "payload too large" } });
      return undefined;
    }
    sendJson(res, 400, { error: { code: "bad_request", message: "malformed body" } });
    return undefined;
  }
}

// Unknown top-level keys are rejected rather than dropped, matching
// memory-events-route.ts and the controller's own `.strict()` schemas. Silently
// swallowing a key the caller believes is doing something is the failure mode
// both sides are avoiding.
function rejectUnknown(body: object, known: readonly string[], res: ServerResponse): boolean {
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length === 0) return false;
  sendJson(res, 400, {
    error: { code: "bad_request", message: `unknown field(s): ${unknown.join(", ")} — allowed: ${known.join(", ")}` },
  });
  return true;
}

function isIdentityChannel(v: unknown): v is (typeof IDENTITY_CHANNELS)[number] {
  return typeof v === "string" && (IDENTITY_CHANNELS as readonly string[]).includes(v);
}

export async function handleIdentityFind(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
): Promise<void> {
  const clientId = await authenticate(req, res, deps);
  if (!clientId) return;

  const body = await readBody<IdentityFindBody>(req, res);
  if (!body) return;
  if (rejectUnknown(body, ["identifier", "channel"], res)) return;

  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  if (!identifier) {
    sendJson(res, 400, { error: { code: "bad_request", message: '"identifier" must be a non-empty string' } });
    return;
  }
  if (!isIdentityChannel(body.channel)) {
    sendJson(res, 400, {
      error: {
        code: "bad_request",
        message: `"channel" is required and must be one of: ${IDENTITY_CHANNELS.join(", ")}`,
      },
    });
    return;
  }

  const coordinator = deps.getCoordinator();
  if (!coordinator) {
    sendJson(res, 503, { error: { code: "tunnel_unavailable", message: "no tunnel connected" } });
    return;
  }

  try {
    // No timeout override — an exact single-row lookup fits the 8s default.
    // A result of { identity: null } is a successful 200; see the header note.
    const result = await coordinator.call(`machine-api:${clientId}`, undefined, FIND_ACTION, {
      identifier,
      channel: body.channel,
    });
    sendJson(res, 200, { result });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "controller_error";
    const message = (err as Error)?.message ?? String(err);
    sendJson(res, code === "tunnel_unavailable" ? 503 : 502, { error: { code, message } });
  }
}

export async function handleIdentityList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
): Promise<void> {
  const clientId = await authenticate(req, res, deps);
  if (!clientId) return;

  const body = await readBody<IdentityListBody>(req, res);
  if (!body) return;
  if (rejectUnknown(body, ["match", "channel", "limit", "timeoutMs"], res)) return;

  if (body.match !== undefined && typeof body.match !== "string") {
    sendJson(res, 400, { error: { code: "bad_request", message: '"match" must be a string when present' } });
    return;
  }
  // Optional here, unlike on find — it only narrows the result set, so absence
  // means "any kind" rather than "guess the kind".
  if (body.channel !== undefined && !isIdentityChannel(body.channel)) {
    sendJson(res, 400, {
      error: { code: "bad_request", message: `"channel" must be one of: ${IDENTITY_CHANNELS.join(", ")} when present` },
    });
    return;
  }
  if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isFinite(body.limit))) {
    sendJson(res, 400, { error: { code: "bad_request", message: '"limit" must be a finite number when present' } });
    return;
  }
  if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs))) {
    sendJson(res, 400, { error: { code: "bad_request", message: '"timeoutMs" must be a finite number when present' } });
    return;
  }

  // Clamped, not rejected — mirroring how the controller treats ttlSeconds on
  // inject. An out-of-range value is a caller misjudging their own account size,
  // not a malformed request, and failing it would be less useful than honouring
  // the nearest legal value.
  const timeoutMs = Math.min(
    LIST_MAX_TIMEOUT_MS,
    Math.max(LIST_MIN_TIMEOUT_MS, typeof body.timeoutMs === "number" ? body.timeoutMs : LIST_DEFAULT_TIMEOUT_MS),
  );

  const coordinator = deps.getCoordinator();
  if (!coordinator) {
    sendJson(res, 503, { error: { code: "tunnel_unavailable", message: "no tunnel connected" } });
    return;
  }

  try {
    // `limit` is forwarded only when supplied. Omitting it deliberately returns
    // the whole account (see header) — the connector must not substitute a
    // default page size, since a silent cap is the exact failure the controller
    // refused to ship.
    const result = await coordinator.call(
      `machine-api:${clientId}`,
      undefined,
      LIST_ACTION,
      {
        ...(body.match ? { match: body.match } : {}),
        ...(body.channel ? { channel: body.channel } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      },
      timeoutMs,
    );
    sendJson(res, 200, { result });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "controller_error";
    const message = (err as Error)?.message ?? String(err);
    sendJson(res, code === "tunnel_unavailable" ? 503 : 502, { error: { code, message } });
  }
}

export function createIdentityRoutes(deps: IdentityRoutesDeps) {
  return {
    handleFind: (req: IncomingMessage, res: ServerResponse) => handleIdentityFind(req, res, deps),
    handleList: (req: IncomingMessage, res: ServerResponse) => handleIdentityList(req, res, deps),
  };
}
