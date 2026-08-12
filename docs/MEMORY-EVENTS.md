# MEMORY-EVENTS — enterprise-injects-context walkthrough

> **Status:** shipped. Three machine-API routes cover this —
> `POST /v1/identity/find`, `POST /v1/identity/list`, and
> `POST /v1/memory/events`. Two paths reach the same three controller actions:
> the machine-API routes (§1–§10, the first-class path) and a Twilio-bundled
> MCP's own tools calling `callControllerApi` (§11, still supported).
> **Repo location:** `examples/demos/memory-inject-demo/` (machine-API driver) and
> `examples/demos/memory-event-demo/` (MCP-tool reference) — both self-contained,
> both reference material; the connector does not read from `examples/` at runtime.

This document walks through the flow that lets an enterprise's own system tell
an agent something out of band — "your flight is delayed" — through the tunnel,
from the connector side. It's the sibling of
[`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md): same mechanism, different
controller actions, and materially lower-stakes ones (no Twilio spend, no
real-world side effect to confirm before firing).

**What it writes.** One note into the named agent's **working memory** — the
live conversational surface, the tier that represents "the agent has been told
something." Not episodic (those rows are authored by the controller's
summariser at flush time; hand-writing one forges the output of a pipeline) and
not semantic (that tier was retired controller-side; durable customer
attributes live in the CRM and are re-fetched per session). There is **no tier
selector** on this action, and there will not be one — working is the only tier
with a legitimate external write.

**It is a resolve-then-write flow, not one call.** `POST /v1/memory/events`
takes an opaque `identityId`, never an address — you resolve one first via
`POST /v1/identity/find`. §3 explains why that split exists and why it isn't
the extra friction it looks like.

## 1. The flow, end to end

```
enterprise's own system
  -> examples/demos/memory-inject-demo/run-memory-inject.sh   (plays the role of "the enterprise's own system")
  -> POST /oauth/token on the connector's inspector            (mint a bearer — see docs/NETWORK-ACCESS.md)

  -> POST /v1/identity/find    { identifier, channel }
       -> ControllerApiCoordinator.call() -> controller-call frame over the tunnel WS
       -> controller's identity.find  (account-scoped, LOOKUP-ONLY)
       -> { identity: IdentitySummary | null }

  -> POST /v1/memory/events    { agentId, identityId, event, ttlSeconds? }
       -> ControllerApiCoordinator.call() -> controller-call frame
       -> controller's memory.inject_context
          -> agentId + identityId both resolved account-scoped
          -> one { role: 'system' } note appended to the agent's working memory
       -> { stored: true, expiresAt }

  -> then POST /v1/outbound/calls, or just wait for the customer to make contact
```

No MCP involved anywhere in this path — all three are machine-API routes,
JWT-bearer-gated, that any external system can call directly, and **one bearer
covers all of them**. It can be either a self-issued (HS256) token from
`/oauth/token` or a federated (RS256) token from the customer's own IdP once a
trusted issuer is configured (see
[`docs/NETWORK-ACCESS.md`](NETWORK-ACCESS.md) "Federated mode") — the routes
verify both and the caller doesn't need to know which. Every hop after the
driver script is generic mechanism, not memory-specific — see
[`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md) §"v1.4 — Controller API calls
(Twilio-bundled only)" for the wire contract (`ControllerCallFrame` /
`ControllerCallResponseFrame`) that everything below rides on, and
`connector/src/inspector/memory-events-route.ts` +
`connector/src/inspector/identity-routes.ts` for the routes' own auth +
validation layer on top of it.

**`POST /v1/identity/list`** sits alongside `find`: same bearer, same
mechanism, but it answers "who do you know" rather than resolving one known
identifier. §5 covers it, including the one sharp edge (no cap, no cursor).

## 2. Params and result

The connector treats `params` as opaque and forwards them verbatim; the
controller owns the semantics. Every controller schema here is `.strict()` — a
stray key is rejected with `invalid_params`, never silently dropped — and these
routes mirror that strictness locally, so an unknown field is a `400` here
rather than a wasted round trip.

```ts
// POST /v1/identity/find request body
{
  identifier: string,       // REQUIRED — your customer reference, in your namespace
  channel: string,          // REQUIRED — "phone" | "email" | "webchat-uid"; never derived
}
// 200 response — `identity: null` is a NORMAL answer, see §4
{ result: { identity: IdentitySummary | null } }


// POST /v1/memory/events request body
{
  agentId: string,          // REQUIRED — whose working memory receives the note
  identityId: string,       // REQUIRED — from /v1/identity/find. NOT an address.
  event: string,            // REQUIRED, non-empty — the fact
  occurredAt?: string,      // ISO 8601; controller defaults to now
  ttlSeconds?: number,      // default 600; >86400 clamped, but 0/negative/fractional REJECTED — see §6
  idempotencyKey?: string,  // optional pass-through, never minted — see §7
}
// 200 response — note it does NOT echo identityId; you supplied it
{ result: { stored: true, expiresAt: string } }


// POST /v1/identity/list request body — every field optional
{
  match?: string,           // case-insensitive substring on alias values
  channel?: string,         // optional narrowing; omit for any kind
  limit?: number,           // OMIT for the account's full identity set — see §5
  timeoutMs?: number,       // route-level, not forwarded; default 30000, clamped 1000-120000
}
// 200 response
{ result: { identities: IdentitySummary[] } }
```

`find` and `list` return the same record, so you parse one type:

```ts
interface IdentitySummary {
  identityId:    string;
  isTemp:        boolean;   // false once a CRM hydration confirmed it
  provider:      string;    // "postgres" for controller-native identities
  externalRef:   string;    // self-equal when provider is "postgres" — read it WITH provider
  aliases:       Array<{ channel: "phone"|"email"|"webchat-uid"|"test-harness"; value: string }>;
  lastEngagedAt: string | null;   // ISO 8601, across ALL agents
  sessionCount:  number;          // all-time, across ALL agents
}
```

`aliases` is the **full** set, never narrowed by your `match`/`channel` — search
by email and you still get their phone. You asked to resolve your customer, so
you get the record, not an echo of your query. Note `test-harness` can appear
here even though it's refused as an input `channel`; it's a controller-internal
construct.

**`agentId` is required on the write**, and this is the one place the contract
reversed during development. Working memory is keyed
`(accountId, agentId, identityKey)` — there is no way to write it without naming
an agent. (An earlier note in `MCP-PROTOCOL.md` said this action carried no
`agentId` because "memory is cross-agent by design"; that was true of an
*episodic* write, whose table has no agent column, and is impossible for a
working-memory write.)

Note the asymmetry, since it's easy to misread: **the write needs an `agentId`;
`find` and `list` do not.** Identity is per-account, not per-agent — a customer
can be well known to the account while never having used the agent you're
injecting against. That case works.

Both `agentId` and `identityId` are resolved through **account-scoped** lookups,
and a merged (dead) identity handle is refused the same way, so expect
`cross_account` — not `invalid_params` — for a handle from the wrong account.

## 3. Why resolution is a separate call

`POST /v1/memory/events` does **not** accept an address. It used to: you sent
`customer: "+15551234567"` and the controller resolved it internally. That
resolve was find-or-**create**, which made three failure modes structural:

1. **A typo minted a phantom customer.** One wrong digit created a real
   identity row with a real working-memory row hanging off it — and let an
   external caller grow the controller's identity tables at will.
2. **It couldn't express a webchat UID.** Phone numbers and email addresses are
   self-describing by shape; an opaque session UID is not. So the handler had to
   *reject* anything that wasn't E.164 or an email, cutting out a whole class of
   identifier enterprises actually hold.
3. **Failure was silent and late.** A mistyped address "succeeded". Nobody found
   out until the agent failed to mention the fact on the call.

Splitting resolution out fixes all three at once: lookup is now read-only, you
state the kind (so opaque UIDs work), and an unknown customer comes back as
`null` immediately.

**`channel` is required on `find` and the controller will not derive it.** Its
normalisation is kind-aware — lowercase for email, trim-only for phone and
webchat-uid — so an exact lookup is impossible without knowing the kind.

| `channel` | Covers |
|---|---|
| `phone` | E.164 numbers. Also the resolution kind for `sms`, `voice`, `whatsapp`, `rcs`, `mms` — the old 9-value channel enum folded onto four kinds internally, so the finer label was never observable at lookup time. |
| `email` | Email addresses. |
| `webchat-uid` | Opaque session UIDs. **Only reachable because you state the kind.** |

`test-harness` is refused on input — it's a controller-internal construct.

Sniffing the kind from the string shape is exactly what the retired `customer`
field did, and is precisely why webchat UIDs were unreachable. Being asked for
it is the fix, not a regression.

**The connector validates presence and enum membership, not resolvability.**
It checks `identifier` is a non-empty string and `channel` is one of the three,
then stops. `identityId` on the write is checked for non-emptiness only and
deliberately **not** pattern-matched — the id format is the controller's to
change, and a connector-side guess at what an id looks like would reject valid
handles the day that format moves. Strings are trimmed, and the trimmed value is
what's forwarded; optional fields are omitted from the forwarded params entirely
when absent rather than sent as `undefined`.

The one exception to pass-it-through is the `channel` enum, which the connector
does hold a local copy of. It earns that coupling three ways: the field is
required, so a missing value has to be caught locally anyway; the set is closed
and small; and `test-harness` is a plausible caller guess the controller
explicitly refuses, so naming the valid set locally turns an opaque
`invalid_params` round trip into a precise `400`. The cost is real and accepted —
a channel kind added controller-side needs a connector bump before callers can
use it.

## 4. When `find` returns `identity: null`

**This is a normal answer, not an error path to log and drop.** It means you
have a customer the controller has never interacted with. The natural but wrong
reading is "injection is broken for new customers."

- **Never contacted:** call `POST /v1/outbound/calls` with your fact in
  `callContext`. It rides the call into the hydration bag. There's no memory to
  prepare because there's no conversation history to add to.
- **Known:** `POST /v1/memory/events`, then place the call (or wait).

The demo driver exits **3** for this case, distinct from a real failure's 1, and
prints the alternative.

## 5. `POST /v1/identity/list` — no cap, no cursor

`list` answers "who do you know", which `find` (exact match, 0 or 1 result)
cannot. Account-scoped, newest first.

**Omitting `limit` returns everything.** The controller considered capping at
100 and rejected it: a cap truncates *silently* — 100 rows back is
indistinguishable from "that's all of them" — whereas an unbounded call can be
slow but cannot lie. The connector honours that and never substitutes a default
page size.

**So the binding constraint is the timeout, not the response size.** The tunnel
WS takes `ws`'s default 100 MiB `maxPayload`, so even a very large list fits in
one frame. What doesn't fit is the clock: this route defaults to **30s** (vs the
coordinator's 8s default that `find` and the write use) and accepts a
caller-supplied `timeoutMs`, clamped to 1000–120000. Clamped rather than
rejected — an out-of-range value is a caller misjudging their own account size,
not a malformed request.

**On timeout you get nothing, not a partial result.** Raise `timeoutMs` for a
large account, or narrow with `match`/`channel`.

**Do not retry a timed-out `list` — raise `timeoutMs` instead.** There is no
cancellation path. When your window elapses the connector stops waiting, but the
controller's query runs to completion and its reply lands on a request id that's
already been discarded. A retry loop therefore stacks abandoned full-account
scans on the controller, each still executing, while you see nothing but
failures. The connector never auto-retries for this reason, and neither should
your caller.

**One privacy note.** `list` is the first machine-API route that returns bulk
customer PII — every alias value on every identity in the account — rather than
performing one targeted action. The gate is identical to the other `/v1/*`
routes (a valid bearer, account scoping enforced controller-side), but the blast
radius of a leaked bearer is now "enumerate the customer base", not just "dial
or inject". Worth weighing when you decide which systems get a credential.

## 6. What the agent actually sees

This shapes what makes a good `event` string, so it's worth knowing before
writing a caller:

- **Stored as one `{ role: 'system' }` item** in the agent's working history.
  Not `user` (that would put words in the customer's mouth) and not
  `assistant` — that one is the nastiest failure mode, because the agent reads
  its own history, concludes it already delivered the message, and stays silent
  on the outbound call. It presents as a prompt bug, not a memory bug.
- **The controller wraps the text** as
  `[Out-of-band update received <ISO>] <event>`. Your `event` is not stored
  bare: a `system` item is hoisted into the model's top-level system parameter
  and **loses its position in the transcript**, so the note has to state its own
  recency rather than rely on where it sits. Your `event` still reaches the
  audit row unchanged.
- **Multiple injections queue** as separate notes in arrival order — they never
  overwrite. They're serialized through the same per-identity lock live
  conversation turns use, so an injection can't clobber a real turn either.
- **Shelf life is `ttlSeconds`, default 600s.** Working memory is flushed to
  episodic after inactivity, and injection deliberately does **not** reset that
  clock — otherwise a silent customer's row would be held open artificially. The
  600s default equals the controller's own `quietFlushMs` default, so omitting
  the field behaves exactly as it did before the field existed: **inject
  immediately before the outbound leg** that should mention the fact.

  Raise it and **inject-then-wait-for-inbound works too** — which it did not
  before. An injected `system` note isn't a transcript turn, so a row holding
  only injections looked *empty* to the flush sweeper, which marked it flushed
  and destroyed the fact before the customer ever made contact. The TTL holds
  the row open.

  **The range policy is asymmetric, so don't read "clamped" as "anything
  goes".** A value *above* 86400s is clamped, not rejected — the controller's
  absolute-age sweeper flushes a working row at 24h regardless of activity, and a
  longer promise would be a lie, so it silently honours the nearest legal value
  and tells you via `expiresAt`. But **0, negative, and fractional values are
  rejected outright** with `invalid_params`. Read `expiresAt` on the response for
  the post-clamp truth whenever you pass a large value.

  The connector forwards whatever finite number you send and predicts none of
  this — including `0`, which it deliberately does *not* treat as "unset". A
  truthiness check there would swallow the 0 and silently substitute the 600s
  default, so you'd never learn you'd asked for something invalid. One owner per
  rule: the controller's.
- **The episodic tail is automatic, conditional on the agent speaking.** If the
  agent voices the fact, that `assistant` turn is summarised into episodic
  normally, and "flight is delayed" becomes "flight was delayed yesterday" with
  no extra machinery. A fact injected but never spoken leaves no episodic trace
  — deliberate: episodic memory should record what was actually *communicated*,
  and the `controller_action` audit row is the record that the injection
  happened.

## 7. Idempotency — never minted here

`idempotencyKey` (on the write) is pass-through only: supply one and it's
forwarded verbatim, omit it and the field is absent from the request the
controller sees. The route **never mints one for you**, which is a deliberate
difference from
`POST /v1/outbound/calls` (which mints a `randomUUID()` when you omit it — see
[`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) §3).

The reason is blast radius. Dialing or texting twice is a real side effect worth
defaulting to safe. A duplicate note is low-harm — worst case it appears twice
in the working history — and the controller has explicitly decided **not to
dedup in v1** regardless, so a minted key would buy nothing while implying a
guarantee that doesn't exist. Pass your own key only if your caller retries and
you want the controller to see the retry as the same write.

This is also why the driver script has no `Proceed? [y/N]` gate, unlike
`outbound-demo`: there's no spend and no external side effect to confirm.

## 8. Running it

Full setup lives in
[`examples/demos/memory-inject-demo/README.md`](../examples/demos/memory-inject-demo/README.md)
— the short version:

```bash
# 1. Boot the connector (no activation step needed — this route has no MCP).
./scripts/start-connector.sh

# 2. Add an API client from the inspector's Network Access panel, or:
curl -s -X POST http://127.0.0.1:9090/internal/network-access/clients \
  -H 'content-type: application/json' -H 'x-inspector-request: 1' \
  -d '{"name":"memory-inject-demo"}'
# -> {"clientId":"...","clientSecret":"..."} — shown once, save it now.

# 3. Store the credential so it needn't be retyped.
cd examples/demos/memory-inject-demo
cp config.example.json config.json
# edit: clientId/clientSecret from step 2, plus agentId

# 4. One run = one call. Browse, resolve, then write.
./run-memory-inject.sh --list
./run-memory-inject.sh --find --identifier=+15555550123 --channel=phone
./run-memory-inject.sh --inject --agentId=agt_123 --identityId=<from find> \
  --event="your flight is delayed"
```

Each mode maps to exactly one route, and every flag is a field of that route
spelled the same way — see
[the driver's README](../examples/demos/memory-inject-demo/README.md). It fires
immediately with no prompt (§7). If `--find` comes back `null` it exits **3** and
prints the alternative (§4) rather than treating it as a failure.

No `policy.tool_timeout_ms` change is needed, unlike the MCP-tool path (§11):
these aren't tool calls, so the connector's outer tool timeout never applies.
`identity.find` and `memory.inject_context` are an identity resolve and a row
write with no LLM turn, so both routes pass **no** timeout override and inherit
`ControllerApiCoordinator`'s 8s default — contrast `outbound.*`'s explicit 30s,
which it needs because it runs a synchronous LLM turn. `identity.list` is the
exception and defaults to 30s (§5).

## 9. Calling without the demo script

The demo script is a thin wrapper over a few HTTP calls — nothing stops you
doing the same thing directly. One bearer covers all three routes:

```bash
ACCESS_TOKEN=$(curl -s -X POST http://127.0.0.1:9090/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')

# 1. Resolve the customer. `channel` is required — "phone", "email", or "webchat-uid".
curl -s -X POST http://127.0.0.1:9090/v1/identity/find \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identifier":"+15555550123","channel":"phone"}'
# -> {"result":{"identity":{"identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","aliases":[...],...}}}
# -> {"result":{"identity":null}}  = never contacted; see §4

# 2. Write the fact against the id you got back.
curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agt_123","identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","event":"your flight is delayed"}'
# -> {"result":{"stored":true,"expiresAt":"2026-08-12T10:10:00Z"}}

# An email identity resolves the same way — only `channel` differs:
curl -s -X POST http://127.0.0.1:9090/v1/identity/find \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identifier":"someone@example.com","channel":"email"}'

# Hold the note open for an INBOUND contact rather than an immediate outbound leg:
curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agt_123","identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","event":"your order shipped","ttlSeconds":3600}'

# Browse the account. No cap and no cursor — see §5 before running this
# against a large account.
curl -s -X POST http://127.0.0.1:9090/v1/identity/list \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"match":"smith","channel":"email"}'
```

The frame's `mcp` field (see [`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md) §"v1.4 —
Controller API calls") carries `machine-api:<clientId>` for calls made this way,
instead of a bundled MCP's name — the controller's audit trail can still
attribute the write to a specific machine caller via the JWT's `sub` claim. That
applies to all three routes, so a resolve and its follow-up write are
attributable to the same caller.

## 10. Error codes

Identical across all three routes. `not_authorized` (401), `bad_request` (400),
and `payload_too_large` (413) come from the route's own gate, before the call
ever reaches the tunnel. Everything else is either the connector's own `timeout`
/ `tunnel_unavailable` or controller-owned and passed through opaquely as
`502 { error: { code, message } }`:

| Code | HTTP | Where it comes from |
|---|---|---|
| `not_authorized` | 401 | The route's own gate: missing, malformed, or expired bearer token. |
| `bad_request` | 400 | The route's own gate. On the write: malformed JSON, missing/empty `agentId`/`identityId`/`event`, non-string `occurredAt`/`idempotencyKey`, non-numeric `ttlSeconds`, or an unknown top-level field. On `find`: missing/empty `identifier`, or a `channel` outside the three valid kinds. |
| `payload_too_large` | 413 | The route's own gate: body over the read limit. |
| `tunnel_unavailable` | 503 | Connector-side: no live tunnel to send the frame over (or the tunnel closed mid-call). |
| `timeout` | 502 | Connector-side: no reply within the window — 8s for `find` and the write, 30s (or your `timeoutMs`) for `list`. On `list` this means you get **nothing**, not a partial (§5). |
| `unknown_action` | 502 | Controller has no handler for the requested action. |
| `cross_account` | 502 | Controller: the target `agentId` or `identityId` isn't in this tunnel session's account. Also covers a merged (dead) identity handle. |
| `invalid_params` | 502 | Controller: `params` failed the action's `.strict()` schema. |
| `controller_error` | 502 | Controller: everything else. |

Three things that are **not** errors, and shouldn't be handled as such:

- **`identity: null` from `find`** — a `200`. The customer is simply unknown
  (§4).
- **A `ttlSeconds` above 86400** — a `200`, clamped. Read `expiresAt` (§6).
  (A `ttlSeconds` of 0, negative, or fractional is a genuine `invalid_params`,
  though — the policy is asymmetric.)
- **An empty `identities: []` from `list`** — a `200`. Nobody matched.

Notably **not** `no_supervisor` — that's an `outbound.*` channel-availability
check, and an injection doesn't need the agent to have a supervisor procedure
bound. And notably not `invalid_params` for an unresolvable address: resolution
is lookup-only now, so a customer the controller doesn't know is a `null`, not a
rejection.

## 11. The other path — calling these actions from a Twilio-bundled MCP's own tools

Everything above is for an *external* caller. If instead you're authoring a
Twilio-bundled MCP whose own tool logic needs to inject context as part of a
larger action, use the `callControllerApi` SDK helper directly from that tool's
handler (gated to `author === "twilio"` — see CLAUDE.md's "v1.4 — Controller API
calls" and [`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md)).
[`examples/demos/memory-event-demo/`](../examples/demos/memory-event-demo/README.md)
is the reference for that shape and stays in the repo for exactly that reason.
Its flow:

```
run-memory-event.sh
  -> POST /tool/call on the connector's inspector   ({server, tool, args})
  -> memory-event-demo's find tool
  -> callControllerApi("identity.find", { identifier, channel })
  -> POST /internal/controller-api/call on the connector's inspector
  -> ControllerApiCoordinator.call() -> ... same as §1 from here down

  ... then a second /tool/call round trip:
  -> memory-event-demo's invoke tool
  -> callControllerApi("memory.inject_context", { agentId, identityId, event, ... })
```

That demo ships three tools mirroring the three actions — `find`, `list`, and
`invoke` — so the resolve-then-write split is visible on this path too.

**The `tool_timeout_ms` gotcha, unique to this path.** Reaching a tool via
`/tool/call` wraps the call in the connector's own outer
`policy.tool_timeout_ms` — **5000ms by default** (`connector/src/config.ts`) —
which fires before `callControllerApi`'s own ~8s window. 8s is longer than 5s,
so raise it:

```yaml
policy:
  tool_timeout_ms: 10000
```

10 seconds is enough for `find` and `invoke` — no need for the 35000 a
tool-call-mediated `outbound.*` caller would need (see
[`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) §7). Don't assume the 5s default is
safe just because these actions' own timeout is shorter than `outbound.*`'s; it's
still longer than 5s.

**The `list` tool needs 35000 anyway.** It raises `callControllerApi`'s own
window to 30s because `identity.list` is unbounded (§5), so the outer
`tool_timeout_ms` has to clear 30s too or the connector kills the call first.
Only relevant if you actually exercise that tool.

The machine-API routes in §1 have none of this — they aren't tool calls at all.

That demo also needs an activation step the machine-API driver doesn't
(`cp -r examples/demos/memory-event-demo bundled-mcps/memory-event-demo`,
author-gated to `twilio` — see its README for why it can't go through the usual
`customer-mcps/` dev path).

## 12. End-to-end check

Proves the note actually reached the model, not just the database:

1. `POST /v1/identity/find` with a customer you know exists → expect a non-null
   `identity` with a populated `aliases` array.
2. `POST /v1/identity/find` with a deliberate typo → expect `identity: null`,
   **and** confirm on a second call that no identity was created for the typo in
   between. That's the property the old find-or-create shape couldn't offer (§3).
3. `POST /v1/memory/events` with that `identityId`, an `agentId`, and
   `event: "your flight is delayed"`.
4. **Immediately** trigger an outbound call or SMS to that same identity on that
   same agent (see [`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md)). Immediately,
   because injection doesn't reset the flush clock (§6).
5. Confirm the agent raises the delay **unprompted** — that proves the `system`
   note reached the model.
6. Let the working row go idle past the TTL, then confirm the episodic summary
   mentions the delay — that proves the tail works via the agent's own utterance.
7. **TTL check.** Inject with `ttlSeconds: 3600`, wait past 10 minutes with no
   contact, then place the call. The fact must still be there. Before
   `ttlSeconds` existed it would have been silently gone (§6).

Outbound SMS works for this as well as voice: the first outbound SMS body loads
working memory (it previously hard-coded an empty history, so only the
customer's reply could see an injected fact).
