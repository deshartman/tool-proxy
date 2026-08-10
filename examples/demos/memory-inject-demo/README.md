# memory-inject-demo — machine-API driver script

Self-contained: everything for this demo lives in this one folder — the
driver script and the config that exercises it. Reference material — the
connector does not read from `examples/` at runtime.

Smoke test for the machine-API memory-events route
([docs/MEMORY-EVENTS.md](../../../docs/MEMORY-EVENTS.md) /
[docs/MCP-PROTOCOL.md](../../../docs/MCP-PROTOCOL.md) §"v1.4 — Controller
API calls"). Plays the role of a real external system: mints a bearer via
`POST /oauth/token`, then calls `POST /v1/memory/events` directly to invoke
the controller's `memory.append_event` action and prints its result.

No MCP, no drop-in, no `bundled-mcps/` activation step — this script talks
directly to the connector's machine API, which is the whole point of that
route: an external caller shouldn't need a locally-installed MCP just to
inject a memory fact. (If you want to exercise the *other* path — a
Twilio-bundled MCP's own tool calling out via `callControllerApi` — see
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
this route isn't a tool call, so the connector's outer tool timeout never
applies. The only ceiling is `ControllerApiCoordinator`'s 8s default.

## Running the demo

### Option A — config file

```bash
cd examples/demos/memory-inject-demo
cp config.example.json config.json
# edit: clientId/clientSecret from the step above; channel, value, event
./run-memory-inject.sh
```

### Option B — CLI flags, no config file needed

```bash
examples/demos/memory-inject-demo/run-memory-inject.sh \
  --clientId=... --clientSecret=... \
  --channel=sms --value=+15555550123 --event="your flight is delayed"
```

Either way the script prints a summary, mints a bearer token, and POSTs to
`http://127.0.0.1:<port>/v1/memory/events` — **no `Proceed? [y/N]` prompt**,
unlike `outbound-demo`. There's no Twilio spend and no external side effect,
and the controller accepts a duplicate-on-retry as low-harm (it doesn't dedup
in v1). It does write a real fact into a real customer's memory, so point it
at a test identity.

If your connector isn't on the default inspector port 9090 — e.g. a second
instance started with `./scripts/start-connector.sh 9091` per CLAUDE.md's
multi-instance dev workflow — pass `--port=<port>` (or set `INSPECTOR_PORT`):

```bash
./run-memory-inject.sh --port=9091 --clientId=... --clientSecret=... \
  --channel=sms --value=+1... --event="..."
```

## Memory types

`--type` selects which memory store the fact lands in:

| Type | What it's for |
|---|---|
| `episodic` | Something that happened, with a time — "flight delayed on Aug 11". |
| `semantic` | A durable fact about the customer — "prefers a window seat". |
| `working` | Short-lived context for the conversation in flight. |

```bash
./run-memory-inject.sh --channel=sms --value=+1... \
  --event="prefers a window seat" --type=semantic
```

Omit `--type` and the field is left out of the request entirely, so the
controller applies its own default (`episodic`) — which is also what keeps
this route working against a controller that predates memory-type support.

Unlike `--channel`, the route **does** validate `--type` locally (`400
bad_request` on an unknown value). A bad channel fails loudly downstream —
the identity won't resolve, nothing is written. A bad type could write into
the wrong store and go unnoticed until a recall comes back missing the fact,
so it's worth catching before the request leaves.

> Anything other than the default requires controller-side support for the
> `type` param. See [docs/MEMORY-EVENTS.md](../../../docs/MEMORY-EVENTS.md)
> §"Memory types" for the current state of that.

## Optional fields

```bash
./run-memory-inject.sh --channel=sms --value=+1... --event="..." \
  --occurredAt=2026-08-11T10:00:00Z --idempotencyKey=k-123
```

Both are omitted from the request entirely when you don't pass them. The
route **never mints an `idempotencyKey`** on your behalf — that differs from
`/v1/outbound/calls`, which does, because dialing twice is a real side effect
while a duplicate memory fact is not. Pass one yourself only if your own
caller retries and you want the controller to see the retry as the same
write.

## Channel values

`--channel` must be one of the controller's nine: `voice`, `sms`, `rcs`,
`mms`, `whatsapp`, `webchat`, `email`, `chat`, `test-harness`. The
**connector deliberately doesn't enforce this** — that enum is the
controller's single source of truth, so an unknown value passes the route's
gate and comes back as the controller's `invalid_params`. This script warns
locally on an unrecognized value (then sends anyway) so a typo reads as a
typo rather than an opaque error from three hops away.

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
