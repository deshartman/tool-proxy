# outbound-demo — machine-API driver script

Self-contained: everything for this demo lives in this one folder — the
driver script and the config that exercises it. Reference material — the
connector does not read from `examples/` at runtime.

Smoke test for the machine-API outbound-calls route
([docs/OUTBOUND-CALLS.md](../../../docs/OUTBOUND-CALLS.md) §7 /
[docs/MCP-PROTOCOL.md](../../../docs/MCP-PROTOCOL.md) §"v1.4 — Controller
API calls"). Plays the role of a real external system: mints a bearer via
`POST /oauth/token`, then calls `POST /v1/outbound/calls` directly to
invoke the controller's `outbound.place_call` / `outbound.send_message`
action and prints its result.

**CAUTION:** running this places/sends a REAL call/message through
whatever agent/channel the controller resolves — not a simulation.

## Contents

```
outbound-demo/
├── README.md              this file
├── invoke.mjs               driver script (self-issued / HS256) — plays "the enterprise's own system"
├── run-outbound.sh          thin shell wrapper around invoke.mjs
├── invoke-federated.mjs     driver script (federated / RS256) — also plays the IdP
├── run-federated.sh         thin shell wrapper around invoke-federated.mjs
└── config.example.json      tracked template; copy to config.json and fill in real values
```

There are two ways a caller authenticates to `/v1/outbound/calls`, and one
driver for each. Both reuse the same `config.json` for `action`/`to`/
`agentId`/`channelId`; they differ only in where the bearer comes from:

- **Self-issued (`run-outbound.sh`)** — the connector mints an HS256 token at
  `POST /oauth/token` from a `client_id`/`client_secret`. This is the path
  that needs the "Add API client" prerequisite below.
- **Federated (`run-federated.sh`)** — an external IdP signs an RS256 token
  and the connector verifies it against that IdP's JWKS. No API client, no
  `/oauth/token`. See "Testing federated mode" below.

No MCP, no drop-in, no `bundled-mcps/` activation step — this script talks
directly to the connector's machine API, which is the whole point of that
route: an external caller shouldn't need a locally-installed MCP just to
trigger an outbound action. (If you want to exercise the *other* path — a
Twilio-bundled MCP's own tool calling out via `callControllerApi` — see
[`../memory-event-demo/`](../memory-event-demo/README.md), which still
uses that shape.)

## Prerequisite: an API client

The machine API needs its own credential, separate from anything MCP- or
tunnel-related. From the connector's inspector (`http://127.0.0.1:<port>/`),
open the **Network Access** panel and click **Add API client** — this
shows a `client_id`/`client_secret` once (and, if it's the first client on
this connector, flips on non-loopback reachability for `/oauth/token` and
this route — irrelevant for local dev, since loopback always works
regardless). See [docs/NETWORK-ACCESS.md](../../../docs/NETWORK-ACCESS.md)
for the full flow.

## Running the demo

### Option A — config file

```bash
cd examples/demos/outbound-demo
cp config.example.json config.json
# edit: clientId/clientSecret from the step above; to (E.164), agentId,
# channelId — must be real records the controller already knows about
# (Agent + Channel bound to a supervisor procedure); an unknown pair fails
# with no_supervisor / agent_not_found.
./run-outbound.sh
```

### Option B — CLI flags, no config file needed

```bash
examples/demos/outbound-demo/run-outbound.sh \
  --clientId=... --clientSecret=... \
  --to=+15555550123 --agentId=ag_123 --channelId=ch_456 --action=place_call
```

Either way: the script prints a summary, prompts `Proceed? [y/N]`, and on
confirmation mints a bearer token then POSTs to
`http://127.0.0.1:<port>/v1/outbound/calls`. Declining exits cleanly with
no request sent.

If your connector isn't on the default inspector port 9090 — e.g. a second
instance started with `./scripts/start-connector.sh 9091` per CLAUDE.md's
multi-instance dev workflow — pass `--port=<port>` (or set `INSPECTOR_PORT`):

```bash
./run-outbound.sh --port=9091 --clientId=... --clientSecret=... --to=... --agentId=... --channelId=...
```

## Testing federated mode

Federated mode accepts a bearer signed by *your own IdP* instead of one the
connector minted — the connector only verifies it (RS256 signature against
the IdP's JWKS, plus `iss`/`aud`/`exp`). See
[docs/NETWORK-ACCESS.md](../../../docs/NETWORK-ACCESS.md) "Federated mode".

Because the token comes from an IdP, there's nothing for the connector to
mint — so `run-federated.sh` **plays the IdP for you**: it generates a
throwaway RSA keypair, serves its public half as a JWKS on a local port,
configures the connector's trusted issuer to point at it, signs a short-lived
RS256 token, calls the route, then restores the connector's prior
trusted-issuer config (so the test leaves no trace). One command, no external
IdP required:

```bash
cd examples/demos/outbound-demo
# reuses config.json for action/to/agentId/channelId (clientId/clientSecret ignored)
./run-federated.sh --port=9091
```

Same `Proceed? [y/N]` prompt and same real-call caution as `run-outbound.sh`.
A `200` proves the whole federated path: JWKS fetch → RS256 verify →
`iss`/`aud` check → tunnel → controller → Twilio.

**Against a real IdP** (Auth0/Okta/Entra/Keycloak/…): mint a
`client_credentials` RS256 token from your IdP, then either configure the
trusted issuer once in the inspector's **Network Access → Federated JWT**
panel and pass only the token, or let the script configure it via flags:

```bash
./run-federated.sh --port=9091 --token="$REAL_JWT" \
  --issuer=https://your-tenant.example.com/ \
  --jwksUrl=https://your-tenant.example.com/.well-known/jwks.json \
  --audience=mcp-connector
```

The token's `iss`/`aud` must match the configured issuer/audience, and the
JWKS URL must be reachable *from the connector*. Add `--keep-issuer` to leave
the config in place after the run.

> Note on Twilio Org OAuth2 as the IdP: Twilio's Organization-level OAuth
> apps are a client-credentials issuer (`https://oauth.twilio.com/v2/token`),
> which fits the *pattern* — but federated mode here does offline JWKS
> verification only (no token introspection), so it requires Twilio's access
> tokens to be RS256 JWTs with a public JWKS and a pinnable `iss`/`aud`. That
> isn't confirmed in Twilio's public docs; decode a real Org token first to
> check its `alg` and whether a JWKS endpoint is published.

## Wire-format action names

`action: "place_call"` / `"send_message"` map to the wire actions
`outbound.place_call` / `outbound.send_message` inside the route (see
`connector/src/inspector/outbound-calls-route.ts`) — this script's `action`
field matches what the route's own request body expects verbatim.
