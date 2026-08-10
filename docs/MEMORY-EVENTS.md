# MEMORY-EVENTS — enterprise-injects-a-memory-fact walkthrough

> **Status:** shipped. `POST /v1/memory/events` is the machine API's
> production-shaped route for this. Two paths reach the same controller action:
> the machine-API route (§1–§7, the first-class path) and a Twilio-bundled
> MCP's own tool calling `callControllerApi` (§8, still supported).
> **Repo location:** `examples/demos/memory-inject-demo/` (machine-API driver) and
> `examples/demos/memory-event-demo/` (MCP-tool reference) — both self-contained,
> both reference material; the connector does not read from `examples/` at runtime.

This document walks through the flow that lets an enterprise's own system inject
a fact into a customer's memory through the tunnel, from the connector side.
It's the sibling of [`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) — same
mechanism, different controller action (`memory.append_event` instead of
`outbound.place_call`/`outbound.send_message`), and a materially lower-stakes
one: no Twilio spend, no real-world side effect to confirm before firing.

## 1. The flow, end to end

```
enterprise's own system
  -> examples/demos/memory-inject-demo/run-memory-inject.sh   (plays the role of "the enterprise's own system")
  -> POST /oauth/token on the connector's inspector            (mint a bearer — see docs/NETWORK-ACCESS.md)
  -> POST /v1/memory/events on the connector's inspector
  -> ControllerApiCoordinator.call() -> controller-call frame over the tunnel WS
  -> controller's ControllerActionRegistry.invoke()
  -> registerMemoryAppendEventAction -> identity resolve -> memory write
  -> result flows back down the same path as controller-call-response -> HTTP response
```

No MCP involved anywhere in this path — `/v1/memory/events` is a machine-API
route, JWT-bearer-gated, that any external system can call directly. The bearer
can be either a self-issued (HS256) token from `/oauth/token` or a federated
(RS256) token from the customer's own IdP once a trusted issuer is configured
(see [`docs/NETWORK-ACCESS.md`](NETWORK-ACCESS.md) "Federated mode") — the route
verifies both and the caller doesn't need to know which. Every hop after the
driver script is generic mechanism, not memory-specific — see
[`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md) §"v1.4 — Controller API calls
(Twilio-bundled only)" for the wire contract (`ControllerCallFrame` /
`ControllerCallResponseFrame`) that everything below rides on, and
`connector/src/inspector/memory-events-route.ts` for this route's own auth +
validation layer on top of it.

## 2. Params and result

The connector treats `params` as opaque and forwards them verbatim; the
controller owns the semantics. Unlike `outbound.*`, this action takes no
`agentId`/`channelId` — memory is customer-scoped and deliberately
cross-channel/cross-agent (a fact learned on one channel is recallable on any
other). The route only ever collects "who is the customer" (`identity`), "what
happened" (`event`), and optionally which store to put it in (`type`):

```ts
// POST /v1/memory/events request body
{
  identity: { channel: string, value: string },  // see channel values below
  event: string,            // the fact, stored verbatim, e.g. "your flight is delayed"
  type?: string,            // episodic | semantic | working — see §3
  occurredAt?: string,      // ISO 8601; controller defaults to now
  idempotencyKey?: string,  // optional pass-through, never minted — see §4
}

// 200 response
{ result: { identityId: string, stored: true } }
```

Valid `identity.channel` values (mirroring the controller's own
`IDENTITY_CHANNEL_KINDS` in `server/src/memory/append-event-controller-action.ts`):
`voice`, `sms`, `rcs`, `mms`, `whatsapp`, `webchat`, `email`, `chat`,
`test-harness`.

**The connector deliberately does not enforce that channel list.** It validates
that `identity.channel` / `identity.value` / `event` are non-empty strings and
stops there; the enum stays the controller's single source of truth, so
duplicating it here would create a second copy to keep in sync. An unrecognized
channel therefore comes back as the controller's `invalid_params`, not a
connector-side `bad_request`. Same thin-connector precedent as
`outbound-calls-route.ts`, which checks `to`/`agentId`/`channelId` for presence
only and never their semantics.

Strings are trimmed, and the trimmed value is what's forwarded. Optional fields
are **omitted from the forwarded params entirely** when absent rather than sent
as `undefined` — that matters for `type` (§3) and `idempotencyKey` (§4).

## 3. Memory types

`type` selects which memory store the fact lands in:

| Type | What it's for | Example |
|---|---|---|
| `episodic` | Something that happened, with a time. | "flight AA100 delayed on Aug 11" |
| `semantic` | A durable fact about the customer. | "prefers a window seat" |
| `working` | Short-lived context for the conversation in flight. | "is currently choosing a rebooking option" |

**Omit `type` and the field is left out of the request entirely**, so the
controller applies its own default (`episodic`). That's not just a convenience:
it's what keeps this route working against a controller that predates
memory-type support — the default path sends the exact same params it always
did, and only a caller who explicitly asks for a type sends the new field.

> **Controller dependency.** Anything other than the default requires the
> controller's `memory.append_event` handler to read `type` and route the write
> to the matching store. The connector side is complete and forward-compatible;
> until the controller implements it, a `type` other than `episodic` either
> falls back to the controller's default or comes back as `invalid_params`,
> depending on how strict its params schema is. Verify against your controller
> before depending on `semantic` / `working` in production.

Unlike `identity.channel`, the connector **does** validate `type` locally and
answers `400 bad_request` on an unknown value. The asymmetry is deliberate:

- A bad `channel` fails **loudly** downstream — the identity won't resolve, the
  controller answers `invalid_params`, nothing is written.
- A bad `type` could fail **quietly** — the write still happens, just into the
  wrong store (or the controller's default), and nobody notices until a recall
  comes back missing the fact.

A local 400 is strictly better than a silently mis-routed write. The cost is
that a fourth memory type needs a connector release; that's the accepted trade.
The enum lives in one place, `MEMORY_TYPES` in
`connector/src/inspector/memory-events-route.ts`.

## 4. Idempotency — never minted here

`idempotencyKey` is pass-through only: supply one and it's forwarded verbatim,
omit it and the field is absent from the request the controller sees. The route
**never mints one for you**, which is a deliberate difference from
`POST /v1/outbound/calls` (which mints a `randomUUID()` when you omit it — see
[`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) §3).

The reason is the difference in blast radius. Dialing or texting twice is a real
side effect worth defaulting to safe. A duplicate memory write is low-harm —
worst case, the fact is recalled twice — and the controller has explicitly
decided **not to dedup in v1** regardless, so a minted key would buy nothing
while implying a guarantee that doesn't exist. Pass your own key only if your
caller retries and you want the controller to see the retry as the same write.

This is also why the driver script has no `Proceed? [y/N]` gate, unlike
`outbound-demo`: there's no spend and no external side effect to confirm.

## 5. Running it

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

# 3. Configure and run the driver — config file (below) or CLI flags,
#    see examples/demos/memory-inject-demo/README.md for both.
cd examples/demos/memory-inject-demo
cp config.example.json config.json
# edit: clientId/clientSecret from step 2; channel, value, event
./run-memory-inject.sh
```

The script prints a summary and fires immediately — no prompt (§4). No
`policy.tool_timeout_ms` change is needed either, unlike the MCP-tool path
(§8): this route isn't a tool call, so the connector's outer tool timeout never
applies. The only ceiling is `ControllerApiCoordinator`'s 8s default —
`memory.append_event` is a fast identity-resolve plus write, so the route
passes no override (contrast `outbound.*`'s explicit 30s, which it needs
because it runs a synchronous LLM turn).

## 6. Calling without the demo script

The demo script is a thin wrapper over two HTTP calls — nothing stops you doing
the same thing directly:

```bash
ACCESS_TOKEN=$(curl -s -X POST http://127.0.0.1:9090/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')

curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identity":{"channel":"sms","value":"+15555550123"},"event":"your flight is delayed"}'

# ... or targeting a specific store (§3):
curl -s -X POST http://127.0.0.1:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identity":{"channel":"sms","value":"+15555550123"},"event":"prefers a window seat","type":"semantic"}'
```

The frame's `mcp` field (see [`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md) §"v1.4 —
Controller API calls") carries `machine-api:<clientId>` for calls made this way,
instead of a bundled MCP's name — the controller's audit trail can still
attribute the write to a specific machine caller via the JWT's `sub` claim.

## 7. Error codes

`not_authorized` (401), `bad_request` (400), and `payload_too_large` (413) come
from this route's own gate, before the call ever reaches the tunnel. Everything
else is either the connector's own `timeout` / `tunnel_unavailable` or
controller-owned and passed through opaquely as `502 { error: { code, message } }`:

| Code | HTTP | Where it comes from |
|---|---|---|
| `not_authorized` | 401 | This route's own gate: missing, malformed, or expired bearer token. |
| `bad_request` | 400 | This route's own gate: malformed JSON, missing/empty `identity.channel`/`identity.value`/`event`, non-string `occurredAt`/`idempotencyKey`, or an unknown `type` (§3). |
| `payload_too_large` | 413 | This route's own gate: body over the read limit. |
| `tunnel_unavailable` | 503 | Connector-side: no live tunnel to send the frame over (or the tunnel closed mid-call). |
| `timeout` | 502 | Connector-side: the controller didn't reply within the coordinator's 8s window. |
| `unknown_action` | 502 | Controller has no handler for the requested action. |
| `invalid_params` | 502 | Controller: `params` failed the action's own schema validation — most commonly an unrecognized `identity.channel`. |
| `controller_error` | 502 | Controller: everything else. |

Notably **not** `cross_account` or `no_supervisor` — those are `outbound.*`
account-scope / channel-availability checks that don't apply to a
customer-scoped memory write.

## 8. The other path — calling `memory.append_event` from a Twilio-bundled MCP's own tool

Everything above is for an *external* caller. If instead you're authoring a
Twilio-bundled MCP whose own tool logic needs to append a memory event as part
of a larger action, use the `callControllerApi` SDK helper directly from that
tool's handler (gated to `author === "twilio"` — see CLAUDE.md's "v1.4 —
Controller API calls" and [`docs/MCP-PROTOCOL.md`](MCP-PROTOCOL.md)).
[`examples/demos/memory-event-demo/`](../examples/demos/memory-event-demo/README.md)
is the reference for that shape and stays in the repo for exactly that reason.
Its flow:

```
run-memory-event.sh
  -> POST /tool/call on the connector's inspector   ({server, tool, args})
  -> memory-event-demo's invoke tool
  -> callControllerApi("memory.append_event", { identity, event, ... })
  -> POST /internal/controller-api/call on the connector's inspector
  -> ControllerApiCoordinator.call() -> ... same as §1 from here down
```

**The `tool_timeout_ms` gotcha, unique to this path.** Reaching a tool via
`/tool/call` wraps the call in the connector's own outer
`policy.tool_timeout_ms` — **5000ms by default** (`connector/src/config.ts`) —
which fires before `callControllerApi`'s own ~8s window. 8s is longer than 5s,
so raise it:

```yaml
policy:
  tool_timeout_ms: 10000
```

10 seconds is enough here — no need for the 35000 a tool-call-mediated
`outbound.*` caller would need (see [`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md)
§7). Don't assume the 5s default is safe just because this action's own timeout
is shorter than `outbound.*`'s; it's still longer than 5s. The machine-API route
in §1 has none of this — it isn't a tool call at all.

That demo also needs an activation step the machine-API driver doesn't
(`cp -r examples/demos/memory-event-demo bundled-mcps/memory-event-demo`,
author-gated to `twilio` — see its README for why it can't go through the usual
`customer-mcps/` dev path).
