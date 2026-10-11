// MEMORY-INJECTION — POST /v1/identity/list. The resolve half of memory
// injection's resolve-then-write flow:
//
//   1. POST /v1/identity/list  -> identityId (or an empty array)
//   2. POST /v1/memory/events  -> write the fact (memory-events-route.ts)
//   3. POST /v1/outbound/calls -> place the call, or just wait for inbound
//
// A machine-API route with the same JWT bearer gate, the same
// ControllerApiCoordinator dependency, and the same machine-api:<clientId> audit
// identity as the other /v1/* routes. See docs/MEMORY-EVENTS.md §2.
//
// WHY RESOLUTION IS A SEPARATE CALL. /v1/memory/events used to take an address
// (`customer: "+1555..."`) and let the controller resolve it. That resolve was
// find-or-CREATE, which made three failure modes structural: a typo minted a
// phantom identity (and let an external caller grow the identity table at will);
// an opaque webchat session UID could not be expressed, because only phones and
// emails are self-describing by shape, so the handler had to reject everything
// else; and a mistyped address "succeeded", with nobody finding out until the
// agent failed to mention the fact on the call. Lookup-only resolution fixes all
// three at once.
//
// A SIBLING ROUTE WAS DELETED HERE. POST /v1/identity/find did the exact,
// single-row lookup; identity.list's `identifier` is a case-insensitive
// SUBSTRING, and an exact address is a substring of itself, so one predicate now
// serves both browse and resolve — two query paths over the same data could
// drift. Two consequences worth not rediscovering:
//
//   - `channel` is OPTIONAL here and always was. find needed it REQUIRED because
//     its equality lookup ran against a normalised column and that normalisation
//     is kind-aware; substring matching via ILIKE is case-insensitive on its own
//     and needs no kind. The enum is still enforced when a value IS supplied.
//   - THE CALLER MUST NOT TREAT identities[0] AS "THE" RESOLVE. A full address
//     can match more than one row: `identifier: "des@example.com"` also matches
//     `des@example.com.au`. A caller resolving one customer has to compare
//     against each identity's `aliases` (always the FULL set per identity, never
//     narrowed by the query) to find the exact one. Exact-first-with-substring-
//     fallback was considered and rejected controller-side: it would guarantee
//     one row, but a 1-element result would then mean either "exact hit" or "one
//     substring hit" with no way to tell which.
//
// An EMPTY array is a NORMAL 200 — it carries exactly the meaning find's `null`
// did: "we have no record of this customer." That is a legitimate state with a
// correct alternative (place the call with the fact in `callContext`, since
// there's no conversation history to prepend to), so this route does NOT
// translate it into an HTTP error status. Doing so would push callers toward
// logging-and-dropping a normal answer.
//
// NO SERVER-SIDE CAP AND NO CURSOR. Omitting `limit` returns the account's entire
// identity set. The controller rejected capping at 100 because a silent
// truncation is indistinguishable from "that's all of them", whereas an unbounded
// call can be slow but cannot lie. The binding constraint is therefore THIS
// ROUTE'S TIMEOUT, not response size (the tunnel WS takes ws's 100 MiB default
// maxPayload), and a timeout yields nothing rather than a partial — hence the
// higher default plus the caller-settable override below.
//
// DO NOT ADD A RETRY ON TIMEOUT. There is no cancellation path: when our window
// elapses we stop waiting, but the controller's query runs to completion and its
// reply lands on a requestId the coordinator has already discarded. A retry loop
// therefore stacks abandoned full-account scans on the controller, each still
// executing, while the caller sees only failures. The correct response to a
// timeout is to surface it and tell the caller to raise `timeoutMs` (or narrow
// with `identifier`/`channel`) — which is what the 502 passthrough plus the demo
// driver's error hint do. This is also why the coordinator never auto-retries.
//
// PRIVACY NOTE, worth knowing before adding more read routes: this is the first
// machine-API route that returns bulk customer PII (every alias value on every
// identity in the account) rather than performing one targeted action. The gate
// is identical to the other /v1/* routes — a valid bearer, account scoping
// enforced controller-side — but the blast radius of a leaked bearer is
// "enumerate the customer base", not just "dial or inject".
//
// This is NOT an argument for making it loopback-only. It's a remote API call by
// design — an external system browsing the account is the use case, and the lever
// that actually fits the risk is credential scoping (bearers are per-API-client
// and revocable), not route placement. Narrowing the bind would break the feature
// for every caller to mitigate "who holds a credential". Enumeration is also
// detectable rather than silent: the controller's audit rows carry the returned
// row count, so a bearer sweeping the account leaves a visible trail.

import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readJsonBody } from "./read-body.js";
import { verifyAccessToken, type AccessTokenClaims, type JwtVerifierConfig } from "../auth/jwt.js";
import type { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";

export interface IdentityRoutesDeps {
  // Both read live state per request, never frozen at wiring time — same
  // rationale as the outbound and memory routes: the operator can set/clear the
  // federated trusted-issuer config without a restart, and the coordinator is
  // rebuilt per tunnel dial (undefined between reconnects).
  getVerifierConfig: (token: string) => Promise<JwtVerifierConfig>;
  // Phase 6 (§5.6): the verified claims select the workspace — a self-issued
  // token's `sub` names a client bound to one controller entry, a federated
  // token's `iss` + `aud` name the entry that trusts it. Undefined when that
  // workspace has no live tunnel, or the credential is bound to none.
  getCoordinator: (claims: AccessTokenClaims) => ControllerApiCoordinator | undefined | Promise<ControllerApiCoordinator | undefined>;
}

const LIST_ACTION = "identity.list";

// Enumerated here rather than passed through opaquely, unlike every other field
// on this route. It earns the coupling because the set is closed and small, and
// `test-harness` is a plausible caller guess that the controller explicitly
// REFUSES on input (it's a controller-internal construct that can still appear in
// a returned `aliases` array), so naming the valid set locally turns an opaque
// `invalid_params` round trip into a precise 400. The cost is real and accepted:
// a channel kind added controller-side needs a connector bump before callers can
// use it.
const IDENTITY_CHANNELS = ["phone", "email", "webchat-uid"] as const;

// identity.list can walk the account's entire identity set, so it defaults higher
// than the coordinator's 8s (matching outbound.*'s 30s, rather than inventing a
// third number) and accepts a caller override. The override exists because the
// connector cannot know how large a customer's account is, and without it a
// large-account caller has no recourse from here at all short of a connector code
// change. Clamped at both ends: a pending call holds a coordinator map entry plus
// a timer, and the inspector's HTTP server runs with requestTimeout = 0, so there
// is no other backstop on how long one caller can hold a request open.
const LIST_DEFAULT_TIMEOUT_MS = 30_000;
const LIST_MIN_TIMEOUT_MS = 1_000;
const LIST_MAX_TIMEOUT_MS = 120_000;

interface IdentityListBody {
  identifier?: unknown;
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
// existing routes, which is out of scope.
async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
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

function isIdentityChannel(v: unknown): v is (typeof IDENTITY_CHANNELS)[number] {
  return typeof v === "string" && (IDENTITY_CHANNELS as readonly string[]).includes(v);
}

export async function handleIdentityList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
): Promise<void> {
  const claims = await authenticate(req, res, deps);
  if (!claims) return;
  const clientId = claims.sub;

  let body: IdentityListBody;
  try {
    body = ((await readJsonBody(req)) as IdentityListBody) ?? {};
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: { code: "payload_too_large", message: "payload too large" } });
      return;
    }
    sendJson(res, 400, { error: { code: "bad_request", message: "malformed body" } });
    return;
  }

  // Unknown top-level keys are rejected rather than dropped, matching
  // memory-events-route.ts and the controller's own `.strict()` schemas. Silently
  // swallowing a key the caller believes is doing something is the failure mode
  // both sides are avoiding. `match` lands here now — it was this param's name
  // until the find/list merge, so a caller still sending it gets told.
  const known = ["identifier", "channel", "limit", "timeoutMs"];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    sendJson(res, 400, {
      error: {
        code: "bad_request",
        message:
          `unknown field(s): ${unknown.join(", ")} — allowed: ${known.join(", ")}` +
          (unknown.includes("match") ? ' ("match" was renamed "identifier")' : ""),
      },
    });
    return;
  }

  if (body.identifier !== undefined && typeof body.identifier !== "string") {
    sendJson(res, 400, { error: { code: "bad_request", message: '"identifier" must be a string when present' } });
    return;
  }
  // Optional: absence means "any kind", not "guess the kind". Substring matching
  // is case-insensitive on its own, so unlike the deleted find route this never
  // needs the kind in order to match.
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

  // Clamped, not rejected — an out-of-range value is a caller misjudging their
  // own account size, not a malformed request, and failing it would be less
  // useful than honouring the nearest legal value.
  const timeoutMs = Math.min(
    LIST_MAX_TIMEOUT_MS,
    Math.max(LIST_MIN_TIMEOUT_MS, typeof body.timeoutMs === "number" ? body.timeoutMs : LIST_DEFAULT_TIMEOUT_MS),
  );

  const coordinator = await deps.getCoordinator(claims);
  if (!coordinator) {
    sendJson(res, 503, { error: { code: "tunnel_unavailable", message: "no tunnel connected" } });
    return;
  }

  try {
    // Three things about this params object are load-bearing:
    //
    //  - `limit` is forwarded only when supplied. Omitting it deliberately
    //    returns the whole account (see header) — the connector must not
    //    substitute a default page size, since a silent cap is the exact failure
    //    the controller refused to ship.
    //  - `timeoutMs` is DELIBERATELY ABSENT. It is a connector-side knob only;
    //    the controller's schema is `.strict()` and explicitly refuses it, with a
    //    test pinning that refusal, because silent tolerance would let a real
    //    mistake sit undetected. It travels as the 5th argument instead.
    //  - `identifier` is a SUBSTRING predicate, so the result may hold more than
    //    one row even for a full address. The connector passes the array through
    //    untouched and never picks a winner; disambiguation belongs to the caller
    //    that knows which address it asked about.
    const result = await coordinator.call(
      `machine-api:${clientId}`,
      undefined,
      LIST_ACTION,
      {
        ...(body.identifier ? { identifier: body.identifier } : {}),
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
    handleList: (req: IncomingMessage, res: ServerResponse) => handleIdentityList(req, res, deps),
  };
}
