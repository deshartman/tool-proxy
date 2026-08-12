# memory-inject-demo — machine-API driver script

Self-contained: everything for this demo lives in this one folder — the
driver script and the config that exercises it. Reference material — the
connector does not read from `examples/` at runtime.

Smoke test for the machine-API memory-injection routes
([docs/MEMORY-EVENTS.md](../../../docs/MEMORY-EVENTS.md) /
[docs/MCP-PROTOCOL.md](../../../docs/MCP-PROTOCOL.md) §"v1.4 — Controller
API calls"). Plays the role of a real external system: mints a bearer via
`POST /oauth/token`, then drives the injection flow directly and prints each
result.

What it actually does: drops one note into the named agent's **working
memory** for the customer you name, so the agent has been told something
before its next turn with that customer.

## Why the extra round trip

Injection is **resolve-then-write**, so the default run makes two calls:

```
POST /v1/identity/list    address (substring)  ->  matching identities (may be >1)
POST /v1/memory/events    identityId + agentId + the fact  ->  written
```

`/v1/memory/events` used to take the address itself and let the controller
resolve it. That resolve was find-or-**create**, which made three failure
modes structural:

1. **A typo minted a phantom customer.** One wrong digit created a real
   identity row with a real working-memory row hanging off it — and let an
   external caller grow the identity table at will.
2. **It couldn't express a webchat UID.** Phone numbers and emails are
   self-describing by shape; an opaque session UID isn't. So the handler had
   to *reject* everything that wasn't E.164 or an email.
3. **Failure was silent and late.** A mistyped address "succeeded". Nobody
   found out until the agent failed to mention the fact on the call.

Splitting resolution out fixes all three: lookup is read-only, you can name the
kind (so opaque UIDs work), and an unknown customer comes back as an empty array
immediately.

No MCP, no drop-in, no `bundled-mcps/` activation step — this script talks
directly to the connector's machine API, which is the whole point of that
route: an external caller shouldn't need a locally-installed MCP just to
inject context. (If you want to exercise the *other* path — a Twilio-bundled
MCP's own tool calling out via `callControllerApi` — see
[`../memory-event-demo/`](../memory-event-demo/README.md), which stays the
reference for that shape and does need the activation step.)

## Contents

```
memory-inject-demo/
├── README.md              this file
├── invoke.mjs             driver script — plays "the enterprise's own system"
├── run-memory-inject.sh   thin shell wrapper around invoke.mjs
└── config.example.json    tracked template; copy to config.json and fill in real values
```

Two routes are exercised between them: `/v1/identity/list` (browse or resolve)
and `/v1/memory/events` (the write).

## Prerequisite: an API client

The machine API needs its own credential, separate from anything MCP- or
tunnel-related. From the connector's inspector (`http://127.0.0.1:<port>/`),
open the **Network Access** panel and click **Add API client** — this shows a
`client_id`/`client_secret` once (and, if it's the first client on this
connector, flips on non-loopback reachability for `/oauth/token` and this
route — irrelevant for local dev, since loopback always works regardless).
See [docs/NETWORK-ACCESS.md](../../../docs/NETWORK-ACCESS.md) for the full
flow.

No `policy.tool_timeout_ms` change is needed, unlike `memory-event-demo` —
these routes aren't tool calls, so the connector's outer tool timeout never
applies. `/v1/memory/events` runs on `ControllerApiCoordinator`'s 8s default;
`/v1/identity/list` defaults to 30s and takes a `timeoutMs` override (see
`--list` below).

## One mode = one API call

Each run makes exactly **one** call. Nothing is combined, nothing is derived, and
every flag is a field of that call spelled exactly as the wire spells it:

| Mode | Call | Required | Optional |
|---|---|---|---|
| `--list` | `POST /v1/identity/list` | — | `--identifier` `--channel` `--limit` `--timeoutMs` |
| `--inject` | `POST /v1/memory/events` | `--agentId` `--identityId` `--event` | `--occurredAt` `--ttlSeconds` `--idempotencyKey` |

Only the mode flags plus `--port`, `--clientId` and `--clientSecret` belong to
the script; none of those appear in a request body. **Reading the driver should
tell you the API** — so don't add a flag that renames, combines, or derives a
field, and don't let one mode issue two calls. An earlier version resolved *and*
wrote in a single run, which made the write look as though it accepted an address
when it only ever accepted an `identityId`.

Credentials go in `config.json` (`cp config.example.json config.json`) so a
client secret needn't be pasted into a shell; `agentId` can live there too. Flags
override the file.

## Running it

```bash
cd examples/demos/memory-inject-demo
cp config.example.json config.json   # clientId/clientSecret from the step above

# 1. who does the account know?
./run-memory-inject.sh --list

# 2. resolve one address -> identityId (same call, with --identifier)
./run-memory-inject.sh --list --identifier=+15555550123

# 3. write the fact against that identityId
./run-memory-inject.sh --inject --agentId=agt_123 \
  --identityId=identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13 \
  --event="your flight is delayed"
```

`--list` prints the `identityId` to paste into `--inject`. Supply `--identifier`
to resolve one customer; omit it to browse everyone — including identities whose
only alias is `test-harness`, which no `--identifier` value can reach since
`test-harness` is refused on input.

**`--identifier` is a SUBSTRING, so a full address can match several rows** —
`des@example.com` also matches `des@example.com.au`. The script marks which rows
carry your exact address in their `aliases` rather than picking one for you; that
disambiguation is the pattern to copy, not `identities[0]`.

Credentials can also be passed per-run instead of via the file:

```bash
./run-memory-inject.sh --clientId=... --clientSecret=... --list
```

### More on `--list`

```bash
./run-memory-inject.sh --list --identifier=smith --channel=email
./run-memory-inject.sh --list --timeoutMs=90000
```

`--list` selects the call and takes no value; the substring is `--identifier`,
named as the API names it. `--channel` is optional and only narrows — substring
matching needs no kind.

**There is no cap and no cursor** — omitting `--identifier` and `--limit`
returns the account's entire identity set. The controller rejected capping at
100 because a silent truncation is indistinguishable from "that's all of
them", whereas an unbounded call can be slow but cannot lie. The binding
constraint is therefore the **timeout**, not response size, and a timeout
returns **nothing** rather than a partial list — hence `--timeoutMs` (the
route defaults to 30s and clamps to 1s–120s).

**Raise `--timeoutMs`; don't retry.** There's no way to cancel a query already
running on the controller, so a retry loop stacks abandoned full-account scans
on it while you see only failures.

The script prints a summary, mints a bearer token, and fires — **no
`Proceed? [y/N]` prompt**, unlike `outbound-demo`. There's no Twilio spend and no
external side effect, and the controller accepts a duplicate-on-retry as low-harm
(it doesn't dedup in v1). `--inject` does write a real note into a real agent's
working memory, so point it at a test agent and a test customer.

Exit codes: **0** success, **1** a real failure, **3** `--list` matched no
identity — see "When list comes back empty" below.

If your connector isn't on the default inspector port 9090 — e.g. a second
instance started with `./scripts/start-connector.sh 9091` per CLAUDE.md's
multi-instance dev workflow — pass `--port=<port>` (or set `INSPECTOR_PORT`):

```bash
./run-memory-inject.sh --port=9091 --list --identifier=+1...
```

## The fields

**`agentId`** — the agent whose working memory receives the note. Required
on the write: working memory is keyed `(accountId, agentId, identityKey)`, so
there's no way to write it without naming an agent. It must belong to the
same account as this connector's tunnel session; a foreign agent comes back
as `cross_account` — and so does a foreign or merged `identityId`.

Note the asymmetry: **the write needs an `agentId`; `find` and `list` do
not.** Identity is per-account, not per-agent — a customer can be well known
to the account while never having used the agent you're injecting against.
That case works.

**`identifier` + `channel`** — the pair `find` resolves. `channel` is
**required** and is never inferred: the controller's normalisation is
kind-aware (lowercase for email, trim-only for phone and webchat-uid), so an
exact lookup is impossible without knowing the kind. Valid values:

| `--channel` | For |
|---|---|
| `phone` | E.164 numbers. Also covers `sms`, `voice`, `whatsapp`, `rcs`, `mms` — they all fold to this kind. |
| `email` | Email addresses. |
| `webchat-uid` | Opaque session UIDs. **Only reachable because you state the kind** — the retired address-sniffing shape couldn't express these at all. |

`test-harness` is refused on input; it's a controller-internal construct that
can only *appear* in a returned `aliases` array.

One note per `(agent, identity)` regardless of channel, by the way — working
memory is wire-blind, so a fact injected before an SMS is visible on a later
voice call for free.

**`identityId`** — an opaque handle, not an address. `--list` produces it;
`--inject` consumes it. Never pattern-check it: if the controller's
id format changes, valid handles must keep flowing.

## Optional fields

All three belong to `--inject`:

```bash
./run-memory-inject.sh --inject --agentId=agt_123 \
  --identityId=identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13 --event="..." \
  --ttlSeconds=3600 --occurredAt=2026-08-12T10:00:00Z --idempotencyKey=k-123
```

All three are omitted from the request entirely when you don't pass them.

**`--ttlSeconds`** governs how long the working row is held open. Default
600s, which equals the controller's `quietFlushMs`, so omitting it behaves
exactly as it did before the field existed.

The range policy is **asymmetric**, so don't read "clamped" as "anything
goes". Above 86400s is *clamped* rather than rejected — the controller's
absolute-age sweeper flushes a working row at 24h regardless of activity, and
a longer promise would be a lie, so it honours the nearest legal value and
tells you via `expiresAt` (which the script prints). But **0, negative, and
fractional values are rejected** with `invalid_params`. Neither the script nor
the connector predicts which you'll hit — `0` in particular is forwarded
rather than treated as "unset", so you find out instead of silently getting
the 600s default.

Raise it when you want **inject-then-wait-for-inbound**. That case was
impossible before this field existed: an injected `system` note isn't a
transcript turn, so a row holding only injections looked *empty* to the flush
sweeper, which marked it flushed and destroyed the fact before the customer
ever made contact.

Treat that branch as **unit-covered, not field-proven** — a live test of it can
appear to pass without ever exercising it, since a row that no sweeper tick
happened to visit survives for the wrong reason and looks identical. See
[docs/MEMORY-EVENTS.md](../../../docs/MEMORY-EVENTS.md) §12 step 7.
Inject-then-outbound doesn't depend on it.

**`--idempotencyKey`** is never minted on your behalf — that differs from
`/v1/outbound/calls`, which does, because dialing twice is a real side effect
while a duplicate note is not. Pass one only if your own caller retries and
you want the controller to see the retry as the same write.

## When `list` comes back empty

Not an error, and not a bug to file — the script exits **3** and says so.
It means the controller has never interacted with that customer, so there's
no conversation history to prepend a note to. This carries exactly the meaning
the deleted `find` route's `identity: null` did.

The correct move for a never-contacted customer is to place the outbound call
with the fact in its own `callContext`, where it rides the call into
hydration — see [`../outbound-demo/`](../outbound-demo/README.md). Memory
injection prepares an *existing* conversational surface; it isn't how you
brief an agent about a stranger. If you expected a hit, check for a typo, or
run `--list` to see who's actually known.

## What the agent actually sees

Worth knowing, because it shapes what makes a good `event` string:

- The note is stored as one `{ role: 'system' }` item in the agent's working
  history — not as a customer message, and not as something the agent already
  said.
- The controller **wraps your text** as
  `[Out-of-band update received <ISO>] <event>`. A `system` item gets hoisted
  into the model's top-level system parameter and loses its position in the
  transcript, so the note has to state its own recency. Your `event` reaches
  the audit row unchanged.
- **Multiple injections queue** in arrival order and never overwrite each
  other, and can't clobber a real conversation turn.
- **It survives successive turns until it expires.** A *live* injected note stays
  in the persisted transcript; builder-synthesised `system` items are still
  dropped, because those get re-synthesised each turn and keeping them would
  poison the cache prefix — an argument that never applied to an injected note.
  The check is liveness, not presence, so an expired note is dropped by the same
  predicate and nothing accumulates.

  A consume-once design was tried first and **failed in the field**: stripping the
  note after *any* turn meant a customer's opening "Hi" spent it, and it was gone
  by "what's the status?". The wrapper is deliberately non-directive — it states
  the fact without telling the agent to raise it — so a greeting turn had no
  reason to use it. That's every inbound conversation, not an edge case.
- **The cost: the agent may raise the fact more than once.** A live note goes back
  on the wire every turn until it expires. **Keep `--ttlSeconds` tight when that
  matters** — bounded and recoverable, unlike a silently lost fact.
- **`--ttlSeconds` is genuine shelf life, ~10 minutes by default.** Working memory
  flushes to episodic after `quietFlushMs` of inactivity (default 10 min), and
  injecting deliberately does *not* reset that clock.
- The episodic tail is automatic but conditional on the agent *speaking*: if
  it voices the fact, that turn is summarised into episodic normally.
- **`stored: true` means written, not mentioned.** A fact the agent never voices
  leaves no trace at all — the note expires either way, no episode written — so the
  controller's `controller_action` audit row is the only record the injection
  happened. Don't read a 200 as a guarantee the customer will hear it.

## End-to-end check

```bash
# 1. Resolve.
./run-memory-inject.sh --list --identifier=+15555550123
#    -> matching identities; pick the one whose aliases hold that exact address

# 2. Inject against it.
./run-memory-inject.sh --inject --agentId=agt_123 --identityId=<from step 1> \
  --event="your flight is delayed"

# 3. Immediately trigger an outbound leg to the SAME customer on the SAME agent.
../outbound-demo/run-outbound.sh --agentId=agt_123 --channelId=chn_456 \
  --to=+15555550123 --action=place_call
```

If the agent raises the delay **unprompted**, the `system` note reached the
model. Outbound SMS works for this too — the first outbound SMS body loads
working memory, same as voice. Don't dawdle between 2 and 3: the note expires
600s after the write unless you passed `--ttlSeconds`.

Two extra checks worth running once:

- **Typo safety.** `--list --identifier=<wrong number>`, then `--list` with no
  filter. Expect an empty result from the first and **no** new identity in the
  second. That's the
  property the old find-or-create shape couldn't offer.
- **TTL.** Inject with `--ttlSeconds=3600`, wait past 10 minutes with no
  contact, then place the call. The fact must still be there. Before
  `ttlSeconds` existed it would have been silently gone.

## Federated bearers

`POST /v1/memory/events` accepts a federated (RS256) bearer from your own
IdP exactly as it accepts a self-issued (HS256) one — `verifyAccessToken`
dispatches on the token's own `alg`, and the route reads the trusted-issuer
config fresh from Postgres per request. This driver only implements the
self-issued path; to exercise federated mode, mint the token however your IdP
does and POST it yourself, or crib
[`../outbound-demo/invoke-federated.mjs`](../outbound-demo/invoke-federated.mjs),
which plays the IdP for you. See
[docs/NETWORK-ACCESS.md](../../../docs/NETWORK-ACCESS.md) "Federated mode".
