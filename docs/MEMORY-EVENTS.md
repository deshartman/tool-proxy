# MEMORY-EVENTS — enterprise-injects-context walkthrough

> **Status:** shipped. Resolution and the write are confirmed against a real
> connector; **delivery to the model has not been demonstrated as one chain** —
> see §12, which is specific about which links are proven and which are easy to
> assume.
>
> Two machine-API routes cover this — `POST /v1/identity/list` and
> `POST /v1/memory/events`. Two paths reach the same two controller actions:
> the machine-API routes (§1–§10, the first-class path) and a Twilio-bundled
> MCP's own tools calling `callControllerApi` (§11, still supported).
>
> A third route, `POST /v1/identity/find`, existed briefly and is **deleted**.
> The controller merged it into `identity.list`, whose `identifier` param is a
> case-insensitive substring — and an exact address is a substring of itself, so
> one predicate serves both browse and resolve rather than two query paths that
> could drift over the same data. Calling the old action now returns
> `unknown_action`; the connector route is gone and its path is no longer
> allowlisted for non-loopback callers. §2 covers the one consequence that needs
> real thought: **a full address can match more than one identity.**
>
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
`POST /v1/identity/list`. §3 explains why that split exists and why it isn't
the extra friction it looks like.

**The note survives across turns until it expires**, so `ttlSeconds` is genuine
shelf life. It is not spent by the first turn that happens to load it. The
trade-off runs the other way instead: a live note goes back on the wire every
turn until it expires, so the agent may raise the fact **more than once** inside
the window — see §6.

## 1. The flow, end to end

```
enterprise's own system
  -> examples/demos/memory-inject-demo/run-memory-inject.sh   (plays the role of "the enterprise's own system")
  -> POST /oauth/token on the connector's inspector            (mint a bearer — see docs/NETWORK-ACCESS.md)

  -> POST /v1/identity/list    { identifier?, channel?, limit? }
       -> ControllerApiCoordinator.call() -> controller-call frame over the tunnel WS
       -> controller's identity.list  (account-scoped, LOOKUP-ONLY, substring)
       -> { identities: IdentitySummary[] }   <- may be MORE THAN ONE; [] = unknown

  -> POST /v1/memory/events    { agentId, identityId, event, ttlSeconds? }
       -> ControllerApiCoordinator.call() -> controller-call frame
       -> controller's memory.inject_context
          -> agentId + identityId both resolved account-scoped
          -> one { role: 'system' } note appended to the agent's working memory
       -> { stored: true, expiresAt }

  -> then POST /v1/outbound/calls, or just wait for the customer to make contact
```

No MCP involved anywhere in this path — both are machine-API routes,
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

**`POST /v1/identity/list` is both the browse call and the resolve call.** Omit
`identifier` and it answers "who do you know"; supply a full address and it
resolves that customer. §5 covers its two sharp edges — no cap/no cursor, and
substring matching meaning a full address can return several rows.

## 2. Params and result

The connector treats `params` as opaque and forwards them verbatim; the
controller owns the semantics. Every controller schema here is `.strict()` — a
stray key is rejected with `invalid_params`, never silently dropped — and these
routes mirror that strictness locally, so an unknown field is a `400` here
rather than a wasted round trip.

```ts
// POST /v1/identity/list request body — every field optional
{
  identifier?: string,      // case-insensitive SUBSTRING on alias values. A full
                            // address resolves one customer — but see the warning
                            // below: it can match SEVERAL identities.
  channel?: string,         // optional narrowing; omit for any kind. Optional
                            // because substring matching needs no kind.
  limit?: number,           // OMIT for the account's full identity set — see §5
  timeoutMs?: number,       // route-level, NOT forwarded; default 30000, clamped 1000-120000
}
// 200 response — an EMPTY array is a normal answer, see §4
{ result: { identities: IdentitySummary[] } }


// POST /v1/memory/events request body
{
  agentId: string,          // REQUIRED — whose working memory receives the note
  identityId: string,       // REQUIRED — from /v1/identity/list. NOT an address.
  event: string,            // REQUIRED, non-empty — the fact
  occurredAt?: string,      // ISO 8601; controller defaults to now
  ttlSeconds?: number,      // default 600; >86400 clamped, but 0/negative/fractional REJECTED — see §6
  idempotencyKey?: string,  // optional pass-through, never minted — see §7
}
// 200 response — note it does NOT echo identityId; you supplied it
{ result: { stored: true, expiresAt: string } }
```

> **`identifier` is a substring, so resolve can return more than one row.**
> `identifier: "des@example.com"` also matches `des@example.com.au`. **Never
> write `identities[0]` and treat it as "the" customer.** When you pass a full
> address expecting one person, compare it against each returned identity's
> `aliases` — always the full set per identity, never narrowed by your query — and
> pick the exact match. `examples/demos/memory-inject-demo/invoke.mjs` does this
> and labels the ambiguous cases; copy that shape.
>
> Exact-first-with-substring-fallback was considered and rejected
> controller-side: it would guarantee one row, but a 1-element result would then
> mean either "exact hit" or "one substring hit" with no way to tell which.

`timeoutMs` is the connector's own knob and is **stripped before forwarding** —
the controller's schema is `.strict()` and explicitly refuses it, with a test
pinning that refusal, because silent tolerance would let a real mistake sit
undetected.

The result record:

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

`aliases` is the **full** set, never narrowed by your `identifier`/`channel` —
search by email and you still get their phone. You asked to resolve your
customer, so you get the record, not an echo of your query. That is also what
makes disambiguation possible: it's the field you compare a full address against.
Note `test-harness` can appear here even though it's refused as an input
`channel`; it's a controller-internal construct. An identity whose only alias is
`test-harness` is therefore **reachable only by browsing** — no `identifier`
value resolves it, since you can't filter on a channel the input refuses.

**`agentId` is required on the write**, and this is the one place the contract
reversed during development. Working memory is keyed
`(accountId, agentId, identityKey)` — there is no way to write it without naming
an agent. (An earlier note in `MCP-PROTOCOL.md` said this action carried no
`agentId` because "memory is cross-agent by design"; that was true of an
*episodic* write, whose table has no agent column, and is impossible for a
working-memory write.)

Note the asymmetry, since it's easy to misread: **the write needs an `agentId`;
`list` does not.** Identity is per-account, not per-agent — a customer
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
can name the kind (so opaque UIDs work), and an unknown customer comes back as an
empty array immediately.

**`channel` is optional.** It only narrows the result set — omit it and any kind
matches. A sibling `identity.find` required it, because its equality lookup ran
against a kind-normalised column and that normalisation is kind-aware (lowercase
for email, trim-only for phone and webchat-uid). Substring matching needs no
kind: `ILIKE` is case-insensitive on its own. When you do supply it:

| `channel` | Covers |
|---|---|
| `phone` | E.164 numbers. Also the resolution kind for `sms`, `voice`, `whatsapp`, `rcs`, `mms` — the old 9-value channel enum folded onto four kinds internally, so the finer label was never observable at lookup time. |
| `email` | Email addresses. |
| `webchat-uid` | Opaque session UIDs. |

`test-harness` is refused on input — it's a controller-internal construct, so an
identity whose only alias is `test-harness` can be browsed but not filtered for.

Sniffing the kind from the string shape is what the retired `customer` field did,
and is precisely why webchat UIDs were unreachable. Being *able* to state it is
the fix.

**The connector validates types and enum membership, not resolvability.**
It checks `identifier` is a string when present and `channel` is one of the three
when present, then stops. `identityId` on the write is checked for non-emptiness
only and deliberately **not** pattern-matched — the id format is the controller's
to change, and a connector-side guess at what an id looks like would reject valid
handles the day that format moves. Optional fields are omitted from the forwarded
params entirely when absent rather than sent as `undefined`.

The one exception to pass-it-through is the `channel` enum, which the connector
does hold a local copy of. It earns that coupling two ways: the set is closed and
small, and `test-harness` is a plausible caller guess the controller explicitly
refuses, so naming the valid set locally turns an opaque `invalid_params` round
trip into a precise `400`. The cost is real and accepted — a channel kind added
controller-side needs a connector bump before callers can use it.

**Retired param names are rejected, not ignored.** `match` (this param's name
before the merge) and `customer` (the retired address field on the write) both
return `400` naming the replacement. Silently dropping `match` would run an
unfiltered whole-account query while the caller believed they had narrowed it.

## 4. When `list` returns an empty array

**This is a normal answer, not an error path to log and drop.** It means you
have a customer the controller has never interacted with, and it carries exactly
the meaning the deleted `find` route's `identity: null` did. The natural but
wrong reading is "injection is broken for new customers."

- **Never contacted:** call `POST /v1/outbound/calls` with your fact in
  `callContext`. It rides the call into the hydration bag. There's no memory to
  prepare because there's no conversation history to add to.
- **Known:** `POST /v1/memory/events`, then place the call (or wait).

The demo driver exits **3** for this case, distinct from a real failure's 1, and
prints the alternative.

## 5. `POST /v1/identity/list` — no cap, no cursor, and possibly several rows

`list` is the only identity lookup. Omit `identifier` and it answers "who do you
know"; supply a full address and it resolves that customer. Account-scoped,
newest first.

**A full address can match more than one identity** — `identifier` is a
substring, so `"des@example.com"` also matches `"des@example.com.au"`. Compare
against each result's `aliases` rather than taking `identities[0]`; see the
warning in §2. This is the one part of the find→list merge that needs real code
on your side, not just a renamed field.

**Omitting `limit` returns everything.** The controller considered capping at
100 and rejected it: a cap truncates *silently* — 100 rows back is
indistinguishable from "that's all of them" — whereas an unbounded call can be
slow but cannot lie. The connector honours that and never substitutes a default
page size.

**So the binding constraint is the timeout, not the response size.** The tunnel
WS takes `ws`'s default 100 MiB `maxPayload`, so even a very large list fits in
one frame. What doesn't fit is the clock: this route defaults to **30s** (vs the
coordinator's 8s default that the write uses) and accepts a
caller-supplied `timeoutMs`, clamped to 1000–120000. Clamped rather than
rejected — an out-of-range value is a caller misjudging their own account size,
not a malformed request.

**On timeout you get nothing, not a partial result.** Raise `timeoutMs` for a
large account, or narrow with `identifier`/`channel`.

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
- **It survives across turns until it expires.** The controller's
  `shouldPersistTranscriptItem` keeps a *live* injected note in the persisted
  transcript. Builder-synthesised `system` items are still dropped — those get
  re-synthesised every turn, so persisting them would grow the wire by one item
  per turn and poison the cache prefix. An injected note isn't re-synthesised, so
  that argument never applied to it.

  The predicate tests **liveness, not presence**, so an expired note is dropped by
  the same mechanism that keeps a live one. Nothing accumulates.

  > **This reverses an earlier consume-once design, and the reason is worth
  > keeping.** Stripping the note after any turn was tried and failed in the
  > field, because it combined badly with the deliberately non-directive wrapper
  > (which states the fact but doesn't instruct the agent to raise it). Real
  > customers open with a greeting, so the note was spent on a turn the agent had
  > no reason to use it on, and was gone by the turn that mattered:
  >
  > ```
  > inject "your package will be delayed by 1 day"
  > customer: "Hi"                    -> note stripped here
  > customer: "What is the status?"   -> nothing left to answer from
  > ```
  >
  > That's not an edge case — it's the shape of every inbound conversation.
  > Don't re-introduce consume-once without solving the greeting turn.
- **The cost of that: the agent may raise the fact more than once.** A live note
  goes back on the wire every turn until it expires, so within the TTL window it
  can surface repeatedly. **Keep `ttlSeconds` tight when that matters.** Bounded
  and recoverable, unlike a silently lost fact — which is the trade that was
  deliberately chosen.
- **`ttlSeconds` is genuine shelf life.** Default 600s. Working memory is flushed
  to episodic after inactivity, and injection deliberately does **not** reset that
  clock — otherwise a silent customer's row would be held open artificially. The
  600s default equals the controller's own `quietFlushMs` default, so omitting the
  field behaves exactly as it did before the field existed.

  Raising it is what **inject-then-wait-for-inbound** needs, and that case was
  impossible before the field existed: an injected `system` note isn't a
  transcript turn, so a row holding only injections looked *empty* to the flush
  sweeper, which marked it flushed and destroyed the fact before the customer ever
  made contact. The TTL is what holds the row open.

  **Two different branches are easy to conflate here; only one is field-proven.**
  *A live note surviving successive turns* is confirmed live (a greeting turn
  followed by a real question, with the note still present for the second). *The
  flush sweeper declining to reap a notes-only row past `quietFlushMs` with no
  contact at all* has never run live — it is unit-covered only, and §12 step 7
  explains why a live test of it can appear to pass without the sweeper ever
  facing such a row. Inject-then-outbound depends on neither.

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
  no extra machinery.
- **`stored: true` means WRITTEN, not MENTIONED.** A fact the agent never voices
  leaves **no trace at all** — the note expires either way and no episode is
  written, so the controller's own `controller_action` audit line is the only
  record the injection happened. Don't read a `200` as a guarantee the customer
  will hear it; it guarantees the note was there to be read.

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

# 4. One run = one call. Resolve, then write.
./run-memory-inject.sh --list                                # browse everyone
./run-memory-inject.sh --list --identifier=+15555550123      # resolve one
./run-memory-inject.sh --inject --agentId=agt_123 --identityId=<from list> \
  --event="your flight is delayed"
```

Each mode maps to exactly one route, and every flag is a field of that route
spelled the same way — see
[the driver's README](../examples/demos/memory-inject-demo/README.md). It fires
immediately with no prompt (§7). If `--list` matches nothing it exits **3** and
prints the alternative (§4) rather than treating it as a failure; when it matches
several, it marks which rows carry the exact alias you asked for rather than
picking one (§2).

No `policy.tool_timeout_ms` change is needed, unlike the MCP-tool path (§11):
these aren't tool calls, so the connector's outer tool timeout never applies.
`memory.inject_context` is a row write with no LLM turn, so that route passes
**no** timeout override and inherits `ControllerApiCoordinator`'s 8s default —
contrast `outbound.*`'s explicit 30s, which it needs because it runs a
synchronous LLM turn. `identity.list` can walk the whole account, so it defaults
to 30s and takes a caller override (§5).

## 9. Calling without the demo script

The demo script is a thin wrapper over a few HTTP calls — nothing stops you
doing the same thing directly. One bearer covers both routes:

```bash
ACCESS_TOKEN=$(curl -s -X POST http://127.0.0.1:9090/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')

# 1. Resolve the customer. `channel` is OPTIONAL — it only narrows.
curl -s -X POST http://127.0.0.1:9090/v1/identity/list \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identifier":"+15555550123"}'
# -> {"result":{"identities":[{"identityId":"identity_9f2c1a04-...","aliases":[...],...}]}}
# -> {"result":{"identities":[]}}   = never contacted; see §4
#
# `identifier` is a SUBSTRING, so this can return several rows. Pick the one whose
# `aliases` contains your exact address — do NOT take identities[0]. See §2.

# 2. Write the fact against the id you picked.
curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agt_123","identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","event":"your flight is delayed"}'
# -> {"result":{"stored":true,"expiresAt":"2026-08-12T10:10:00Z"}}
#    stored: true means WRITTEN, not MENTIONED — see §6.

# An email resolves the same way. Narrow with `channel` if the substring is
# ambiguous across kinds:
curl -s -X POST http://127.0.0.1:9090/v1/identity/list \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identifier":"someone@example.com","channel":"email"}'

# Hold the note open longer for an INBOUND contact rather than an immediate
# outbound leg. This is real shelf life — the note survives successive turns until
# it expires, so keep it tight if repeated mentions would be a problem (§6).
curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agt_123","identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","event":"your order shipped","ttlSeconds":3600}'

# Browse the whole account — omit `identifier`. No cap and no cursor, so read §5
# before running this against a large account.
curl -s -X POST http://127.0.0.1:9090/v1/identity/list \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{}'
```

The frame's `mcp` field (see [`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md) §"v1.4 —
Controller API calls") carries `machine-api:<clientId>` for calls made this way,
instead of a bundled MCP's name — the controller's audit trail can still
attribute the write to a specific machine caller via the JWT's `sub` claim. That
applies to both routes, so a resolve and its follow-up write are attributable to
the same caller.

## 10. Error codes

Identical across both routes. `not_authorized` (401), `bad_request` (400),
and `payload_too_large` (413) come from the route's own gate, before the call
ever reaches the tunnel. Everything else is either the connector's own `timeout`
/ `tunnel_unavailable` or controller-owned and passed through opaquely as
`502 { error: { code, message } }`:

| Code | HTTP | Where it comes from |
|---|---|---|
| `not_authorized` | 401 | The route's own gate: missing, malformed, or expired bearer token. |
| `bad_request` | 400 | The route's own gate. On the write: malformed JSON, missing/empty `agentId`/`identityId`/`event`, non-string `occurredAt`/`idempotencyKey`, non-numeric `ttlSeconds`, or an unknown top-level field. On `list`: a non-string `identifier`, a non-numeric `limit`/`timeoutMs`, a `channel` outside the three valid kinds, or the retired `match` field. |
| `payload_too_large` | 413 | The route's own gate: body over the read limit. |
| `tunnel_unavailable` | 503 | Connector-side: no live tunnel to send the frame over (or the tunnel closed mid-call). |
| `timeout` | 502 | Connector-side: no reply within the window — 8s for the write, 30s (or your `timeoutMs`) for `list`. On `list` this means you get **nothing**, not a partial (§5). |
| `unknown_action` | 502 | Controller has no handler for the requested action — what the deleted `identity.find` now returns. |
| `cross_account` | 502 | Controller: the target `agentId` or `identityId` isn't in this tunnel session's account. Also covers a merged (dead) identity handle. |
| `invalid_params` | 502 | Controller: `params` failed the action's `.strict()` schema. |
| `controller_error` | 502 | Controller: everything else. |

Three things that are **not** errors, and shouldn't be handled as such:

- **An empty `identities: []`** — a `200`. The customer is simply unknown (§4).
  This carries the meaning the deleted `find` route's `identity: null` had.
- **Several rows for one full address** — a `200`, and expected: `identifier` is
  a substring (§2). Disambiguate on `aliases`; it is not an error to resolve.
- **A `ttlSeconds` above 86400** — a `200`, clamped. Read `expiresAt` (§6).
  (A `ttlSeconds` of 0, negative, or fractional is a genuine `invalid_params`,
  though — the policy is asymmetric.)

Notably **not** `no_supervisor` — that's an `outbound.*` channel-availability
check, and an injection doesn't need the agent to have a supervisor procedure
bound. And notably not `invalid_params` for an unresolvable address: resolution
is lookup-only now, so a customer the controller doesn't know is an empty array,
not a rejection.

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
  -> memory-event-demo's list tool
  -> callControllerApi("identity.list", { identifier, channel? })
  -> POST /internal/controller-api/call on the connector's inspector
  -> ControllerApiCoordinator.call() -> ... same as §1 from here down

  ... then a second /tool/call round trip:
  -> memory-event-demo's invoke tool
  -> callControllerApi("memory.inject_context", { agentId, identityId, event, ... })
```

That demo ships two tools mirroring the two actions — `list` and `invoke` — so the
resolve-then-write split is visible on this path too. It shipped a third, `find`,
until the controller merged that action away.

**The `tool_timeout_ms` gotcha, unique to this path.** Reaching a tool via
`/tool/call` wraps the call in the connector's own outer
`policy.tool_timeout_ms` — **5000ms by default** (`connector/src/config.ts`) —
which fires before `callControllerApi`'s own ~8s window. 8s is longer than 5s,
so raise it:

```yaml
policy:
  tool_timeout_ms: 10000
```

10 seconds is enough for `invoke` — no need for the 35000 a
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

Proves the note actually reached the model, not just the database.

Steps 1–3 and 6 are cheap and unambiguous. **Steps 4–5 and 7 are the ones that
matter, the ones not yet demonstrated as a single chain, and the ones easiest to
convince yourself of on weaker evidence than you think** — each carries a note on
how a version of it can appear to pass while proving nothing.

1. `POST /v1/identity/list` with `identifier` set to an address you know exists →
   expect at least one identity with a populated `aliases` array, and confirm one
   of them carries that address **exactly**. Several rows is normal, not a bug
   (§2).
2. `POST /v1/identity/list` with a deliberate typo → expect `identities: []`,
   **and** confirm no identity was created for the typo in between. Check the
   alias count for the typo directly rather than eyeballing a list; the old
   find-or-create shape's whole failure mode was being invisible (§3).
3. `POST /v1/memory/events` with that `identityId`, an `agentId`, and
   `event: "your flight is delayed"`. Confirm the row landed.
4. **Immediately** trigger an outbound call or SMS to that same identity on that
   same agent (see [`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md)). Immediately,
   because injection doesn't reset the flush clock (§6).
5. Confirm the agent raises the delay **unprompted**. This is the only step that
   proves the feature works; everything before it proves data moved.

   > **Three substitutions each weaken this to the point of proving something
   > else, and they're easy to make one at a time.** Writing the note straight
   > into the session store instead of through `POST /v1/memory/events` skips the
   > entire connector path. Simulating the inbound as a local HTTP POST instead of
   > a real Twilio message skips routing and identity resolution. And asking a
   > *targeted* question ("any update on my appointment?") only shows the model
   > had the note and used it — not that it would have volunteered it. All three
   > together demonstrate "a system note in working memory reaches the model and
   > shapes the reply", which is worth knowing but is **not** this step. Use the
   > real route, a real inbound, and an open-ended opener.
   >
   > Substituting only *some* of them still leaves this step outstanding, and
   > that's the state today: a real Twilio inbound has read an injected note and
   > answered from it, but that note was written by a probe calling the same
   > functions `memory.inject_context` uses internally rather than through the
   > route. The connector write path is separately proven — real
   > `memory.inject_context` calls land correctly. **Both halves work; a single
   > unbroken connector→Twilio chain has not been demonstrated.**
6. Confirm the episodic summary mentions the delay — that proves the tail works
   via the agent's own utterance (§6). Conditional on step 5: a fact the agent
   never voiced leaves no episodic trace by design.
7. **TTL check.** Inject with `ttlSeconds: 3600`, wait past 10 minutes with no
   contact, then make contact. The fact must still be there — before `ttlSeconds`
   existed it would have been silently gone (§6).

   > **This one can pass without ever exercising the branch it tests.** The
   > mechanism under test is the flush sweeper *declining* to reap a row that
   > holds only injected notes. If no sweeper tick happens to land inside that
   > window, the row survives because nothing looked at it — which is not the
   > same result and looks identical. Check the sweeper actually ran during the
   > wait before believing the pass.
   >
   > Don't let a passing step 5 upgrade this one. *A live note surviving
   > successive turns* and *the sweeper sparing a notes-only row with no contact
   > at all* are different branches; the first is field-proven, this is not.

Outbound SMS works for this as well as voice: the first outbound SMS body loads
working memory (it previously hard-coded an empty history, so only the
customer's reply could see an injected fact).
