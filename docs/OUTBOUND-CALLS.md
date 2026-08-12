# OUTBOUND-CALLS — enterprise-triggers-outbound-call walkthrough

> **Status:** shipped. `POST /v1/outbound/calls` is the machine API's production-shaped route for this. `examples/demos/outbound-demo/` is reference material (not auto-loaded) exercising it end to end.
> **Repo location:** `examples/demos/outbound-demo/` — self-contained: driver script and config, no MCP involved.

This document walks through the flow that lets an enterprise's own system trigger a real outbound Twilio call or SMS through the tunnel, from the connector side. It's the connector-side companion to the controller's own action-registry contract (`docs/CONTROLLER-ACTIONS.md` in the controller repo) — read that doc for what happens after the frame lands on the controller; this doc covers everything up to and including sending the frame.

This route has siblings: **`POST /v1/memory/events`** injects a fact into an agent's working memory over the same tunnel, with the same bearer and the same `machine-api:<clientId>` audit identity, and **`POST /v1/identity/list`** resolves the customer handle that write requires — see [`docs/MEMORY-EVENTS.md`](MEMORY-EVENTS.md). The three together are the whole machine-API surface ([`docs/NETWORK-ACCESS.md`](NETWORK-ACCESS.md) "Machine API routes").

One case where the two features meet: if `identity.list` comes back empty — a customer the account has never interacted with — there is no working memory to inject into, and the correct move is to place the call *here* with the fact in `callContext`, where it rides into the hydration bag. See [`docs/MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §4.

## 1. The flow, end to end

```
enterprise's own system
  -> examples/demos/outbound-demo/run-outbound.sh    (plays the role of "the enterprise's own system")
  -> POST /oauth/token on the connector's inspector   (mint a bearer — see docs/NETWORK-ACCESS.md)
  -> POST /v1/outbound/calls on the connector's inspector
  -> ControllerApiCoordinator.call() -> controller-call frame over the tunnel WS
  -> controller's ControllerActionRegistry.invoke()
  -> registerOutboundPlaceCallAction / registerOutboundSendMessageAction
  -> Twilio Voice / Messaging API
  -> result flows back down the same path as controller-call-response -> HTTP response
```

No MCP involved anywhere in this path — `/v1/outbound/calls` is a machine-API route, JWT-bearer-gated, that any external system can call directly. The bearer can be either a self-issued (HS256) token from `/oauth/token` or a federated (RS256) token from the customer's own IdP once a trusted issuer is configured (see `docs/NETWORK-ACCESS.md` "Federated mode") — the route verifies both and the caller doesn't need to know which. Every hop after the driver script is generic mechanism, not outbound-specific — see `docs/MCP-PROTOCOL.md` §"v1.4 — Controller API calls (Twilio-bundled only)" for the wire contract (`ControllerCallFrame` / `ControllerCallResponseFrame`) that everything below rides on, and see `connector/src/inspector/outbound-calls-route.ts` for this route's own auth + validation layer on top of it.

## 2. Why a driver script, not a direct call

A production enterprise integration would call this from whatever internal system needs to trigger the outbound action — not from a standalone script. The demo's driver script exists to prove the mechanism works without needing that enterprise system built: it mints a bearer and calls `POST /v1/outbound/calls` exactly the way a real caller would, so running it is a faithful preview of what an integration's own code needs to do.

## 3. Params and result

Both `outbound.place_call` and `outbound.send_message` take the identical shape (controller-owned contract; the connector treats it as opaque):

```ts
{
  agentId: string;
  channelId: string;
  to: string;              // E.164
  callContext?: Record<string, string>;
  idempotencyKey: string;  // caller-supplied, or minted by the route if omitted
}

// result
outbound.place_call    -> { callSid: string }
outbound.send_message  -> { providerId?: string }
```

`agentId` / `channelId` must already exist in the controller's own data — a real Agent and Channel, with the Agent bound to a supervisor procedure. An unknown pair fails with `agent_not_found` / `channel_not_found` / `no_supervisor`, mapped to the connector-visible `controller_error` code (see §5).

`idempotencyKey` matters here specifically because dialing or texting twice is a real side effect, not a no-op. The route accepts it as an optional request field — pass your own if your system might legitimately retry a request, so a retry dedupes instead of placing a second call; omit it and the route mints a fresh one (`randomUUID()`) per request. The demo driver script never passes one, since it isn't the kind of caller that retries.

## 4. Running it

Full setup lives in [`examples/demos/outbound-demo/README.md`](../examples/demos/outbound-demo/README.md) — the short version:

```bash
# 1. Boot the connector (no activation step needed — this route has no MCP).
./scripts/start-connector.sh

# 2. Add an API client from the inspector's Network Access panel, or:
curl -s -X POST http://127.0.0.1:9090/internal/network-access/clients \
  -H 'content-type: application/json' -H 'x-inspector-request: 1' \
  -d '{"name":"outbound-demo"}'
# -> {"clientId":"...","clientSecret":"..."} — shown once, save it now.

# 3. Configure and run the driver — config file (below) or CLI flags,
#    see examples/demos/outbound-demo/README.md for both.
cd examples/demos/outbound-demo
cp config.example.json config.json
# edit: clientId/clientSecret from step 2; action, to, agentId, channelId
./run-outbound.sh
```

The script prints a summary and prompts `Proceed? [y/N]` before sending anything — declining exits cleanly with no request made.

**This places/sends a real call or message.** There is no dry-run or sandbox mode; the controller action calls the same Twilio-backed core the controller's own `POST /api/outbound/calls` / `POST /api/outbound/messages` routes call.

## 5. Error codes

`not_authorized` (401) and `bad_request` (400) come from this route's own gate, before the call ever reaches the tunnel. Everything else is either the connector's own `timeout` or controller-owned and passed through opaquely (`error: { code, message }`):

| Code | Where it comes from |
|---|---|
| `not_authorized` | This route's own gate: missing, malformed, or expired bearer token. |
| `bad_request` | This route's own gate: invalid `action`, or missing `to`/`agentId`/`channelId`. |
| `tunnel_unavailable` | Connector-side: no live tunnel to send the frame over. |
| `timeout` | Connector-side: the controller didn't reply within the 30s window. |
| `unknown_action` | Controller has no handler for the requested action. |
| `cross_account` | Controller: the target Agent/Channel doesn't belong to this tunnel's account. |
| `no_supervisor` | Controller: the target Agent has no supervisor procedure bound. |
| `invalid_params` | Controller: `params` failed the action's own schema validation. |
| `controller_error` | Controller: everything else — a richer taxonomy exists on the controller's own HTTP routes, but the tunnel surface only distinguishes the codes above. |

## 6. Calling without the demo script

The demo script is just a thin wrapper over two HTTP calls — nothing stops you from doing the same thing directly:

```bash
ACCESS_TOKEN=$(curl -s -X POST http://127.0.0.1:9090/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')

curl -s -X POST http://127.0.0.1:9090/v1/outbound/calls \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"place_call","to":"+15551234567","agentId":"agt_123","channelId":"chn_456"}'
```

The frame's `mcp` field (see `docs/MCP-PROTOCOL.md` §"v1.4 — Controller API calls") carries `machine-api:<clientId>` for calls made this way, instead of a bundled MCP's name — the controller's audit trail can still attribute the call to a specific machine caller via the JWT's `sub` claim.

## 7. The other path — calling `outbound.*` from a Twilio-bundled MCP's own tool

Everything above is for an *external* caller. If instead you're authoring a Twilio-bundled MCP whose own tool logic needs to trigger `outbound.place_call` / `outbound.send_message` as part of a larger action, use the `callControllerApi` SDK helper directly from that tool's handler (gated to `author === "twilio"` — see CLAUDE.md's "v1.4 — Controller API calls" and `docs/MCP-PROTOCOL.md`). [`examples/demos/memory-event-demo/`](../examples/demos/memory-event-demo/README.md) is the current reference for that shape (targeting `identity.find` / `identity.list` / `memory.inject_context` rather than `outbound.*`, but the mechanism — a Type 1 drop-in tool calling `callControllerApi`, reached via the inspector's loopback `/tool/call` route — is identical). One gotcha unique to that path: reaching the tool via `/tool/call` wraps the call in the connector's own outer `policy.tool_timeout_ms` (5000ms default), which fires before `callControllerApi`'s own 30s window if you don't raise it — see `docs/MEMORY-EVENTS.md`'s equivalent note for the exact yaml change. `/v1/outbound/calls` doesn't have this gotcha (§6 above) since it isn't a tool call at all.
