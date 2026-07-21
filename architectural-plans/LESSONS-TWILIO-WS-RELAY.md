# Lessons from Twilio's Internal WS Relay (`cai-relay`)

**Status:** notes / not-yet-actioned
**Date:** 2026-07-01
**Source:** [twilio-internal/cai-relay](https://github.com/twilio-internal/cai-relay) on the `active` branch, plus the design doc at [`.claude/plans/Twilio Shared Prototype Relay Service - DRAFT.md`](./Twilio%20Shared%20Prototype%20Relay%20Service%20-%20DRAFT.md).

## Scope

This document is about **how they construct the pipe** — DNS, auth, identity, provisioning, slot management — not what flows through it. Their pipe carries audio frames and TwiML hits; ours carries RPC, manifest deltas, creds, webhook ingress. Those are not comparable surfaces.

**Important asymmetry to keep in mind throughout:**

- **cai-relay hosts Agent Connect + Conversation Relay on the developer's laptop.** The relay is a transparent byte pipe between Twilio and the laptop. STT/TTS WS messages flow through the relay but are never inspected. The laptop is the LLM + audio endpoint.
- **Our connector puts Conversation Relay on the controller side.** The customer-side connector is a tool dispatcher; the controller speaks to Twilio. We have heavy upstream reliance on the controller for MCP roster, creds, approval state, webhook URL minting — none of which exists in cai-relay's model.

So when we ask "what can we learn from how they construct the pipe," the question is really: **given that we have much more state to carry than they do, where did their stateless choices give them simplicity we'd benefit from inheriting?**

The headline question the user asked: **would tying the pipe to a Twilio Account SID like they do cut down on config work for us?** Short answer: yes, materially, for at least three of our config knobs. Detail below.

---

## How they build the pipe — the five load-bearing pieces

### 1. DNS is identity

The single most consequential choice in cai-relay: **AccountSid lives in the subdomain**, not in a config file, not in a registration handshake, not in a database row.

- Route 53 wildcard: `*.relay.twil.io → ALB`
- ACM wildcard cert: `*.relay.twil.io`
- ALB host-based routing rule: anything matching `*.relay.twil.io` lands on the relay target group
- Relay extracts AccountSid from the `Host` header on every request: `AC36375.relay.twil.io` → `account_sid = "AC36375"`

That's the whole identity story. **No subdomain pre-provisioning. No DB row. No registration step.** A wildcard cert + a wildcard DNS record + 3 lines of Go that parse `Host` gives them a stable per-account public URL surface for free.

The cost they pay is: identity is exactly as durable as DNS + a wildcard cert. They don't get to attach metadata to "this account on our relay" — the relay literally doesn't know an account exists until a connect arrives.

### 2. Auth is verify-on-every-connect, no caching

On `/agent/` upgrade ([`wsrelay/main.go:50-60`](https://github.com/twilio-internal/cai-relay/blob/active/wsrelay/main.go)):

1. Extract AccountSid from `Host` header. Reject 403 if pattern doesn't match `AC...`.
2. Extract HTTP Basic Auth from upgrade headers (`Authorization: Basic <base64(apiKey:apiSecret)>`).
3. Synchronously call `GET https://api.twilio.com/2010-04-01/Accounts/{sid}.json` with those creds. Reject 401 on anything but 200.

**No bearer storage, no bcrypt hash table, no rotation grace window.** They lean on Twilio REST as the source of truth and re-verify every connect. Fine because each connect is one short-lived audio session.

### 3. Session = sqid + Redis TTL

After auth, the relay generates an 8-char hex sqid server-side, writes it to a Redis hash with TTL = 300s, and sends `{"sqid":"a1b2c3d4"}` back to the developer over the now-open WS. The developer pastes `https://{sid}.relay.twil.io/twiml/{sqid}` into their Twilio webhook config and that's the pairing key.

No reconnection handshake, no resume semantics. WS close → TTL frees the slot → next connect is a fresh sqid. The TTL *is* the GC.

### 4. Slot count via Redis Set + `SCARD`

Three sessions max per account, enforced via a per-account `account:{sid}:sessions` Redis Set and `SCARD` on connect. Stale eviction (`last_heartbeat > 2× heartbeat_interval`) runs at connect-time, not as a background sweep.

### 5. ALB does TLS, relay speaks plaintext

The relay binary speaks plain HTTP on port 9099 inside the Fargate task. ACM cert is attached to the ALB listener, ALB terminates TLS, relay never sees the cert. Wildcard cert + auto-renewal via DNS validation is somebody else's problem.

---

## Direct side-by-side: how each piece compares

| Pipe-construction concern | cai-relay | Our connector | Notes |
|---|---|---|---|
| Per-tenant public URL | `*.relay.twil.io` wildcard + Host-header extract | None — we dial outbound to a single controller URL | We don't need a public URL on the connector side at all (outbound-only). But we *do* mint one on the controller for webhook ingress per-(connectorId, mcp) — that pattern is closer to theirs than it first looks (see §"Webhook ingress" below). |
| Identity anchor | AccountSid (from DNS subdomain) | Connector-chosen `CONNECTOR_NAME` + controller-minted `registrationToken` | We carry our *own* opaque identity. They lean on Twilio's. |
| Provisioning step | None — wildcard cert covers any SID | Operator creates a `tunnel_security_configs` row in the controller UI before the connector can boot | This is the single biggest config-work delta. See §"What we'd save by anchoring to Twilio account" below. |
| Auth credential | Twilio API Key + Secret in WS URL Basic auth | `ts_<rowId>_<random>` static bearer OR OAuth2 `client_credentials` | Both Twilio-rooted in spirit, but ours has to be minted by an operator in the controller first. |
| Credential validation | Per-connect REST call to `api.twilio.com` | Per-connect bcrypt verify against stored row | We don't hit Twilio on auth; we hit our own DB. |
| Rotation story | Rotate API Key in Twilio console → new dev WS URL | Click "Rotate Secret" on the row → 24h grace via `secret_rotation_grace_until` | Different posture (ours has grace windows; theirs has none) because their sessions are 5 min, ours are weeks. |
| Reconnect | None — SDK redials | Auto-reconnect w/ backoff, suppressed on `unknown_registration_token` | We have to; they don't. |
| TLS | ALB-terminated wildcard ACM cert | Whatever the controller fronts itself with (today: customer-provided per-deployment) | They've out-sourced this entirely to AWS infra; we haven't said much about it. |
| Per-tenant scaling cap | 3 sessions/AccountSid via Redis Set | One container per `tunnel.name` (implicit cap of 1) | We don't multiplex; they do. |

---

## Pipe construction — what we can learn

### A. The DNS-as-identity trick is real, and partly applicable to us

Two distinct surfaces where we currently do registration work that DNS could replace:

**Surface 1 — the connector's identity to the controller.** Today: operator creates a Tunnel Security row, mints a `ts_…` bearer, customer pastes it into `.env`. Five clicks + a copy-paste, per connector.

A "DNS-as-identity" equivalent for us would look like: the controller serves `*.controllers.twilio-something.com`, each tenant's connector dials `wss://AC36375.controllers.twilio-something.com/mcp-tunnel`, the controller extracts AccountSid from the Host header and treats that as the tenant binding. **Saves the row-creation step entirely** for the "this customer has one connector" common case. The customer still needs *some* credential to prove they own that SID (API Key + Secret as Basic auth on the WS upgrade, exactly like cai-relay), but they already have those — no new secret to mint.

The connector_id becomes synthetic: `connector_id = sha256(account_sid + connector_name)` or similar. The "tunnel security row" disappears as a concept for single-connector customers; we'd only mint a real DB row when the customer wants the *extra* state we currently store there (custom name, multiple connectors per account, OAuth2 posture).

**Surface 2 — webhook ingress URLs.** Today: controller mints `https://<controller-host>/api/webhook/<connectorId>/<token>` per allocation. The `<connectorId>` path segment is the routing key. This is *structurally identical* to cai-relay's `https://{sid}.relay.twil.io/twiml/{sqid}` — they just put the routing key in the subdomain, we put it in the path. **No lesson to copy here** beyond noting we already built the same pattern; it works.

### B. Provisioning is the biggest config delta, and most of it is removable

Setting up a new connector today requires:

1. Operator clicks **New Tunnel Security Config** in the controller UI
2. Operator pastes Twilio AccountSid + AuthToken (or AccountSid + ApiKey)
3. Controller verifies against Twilio's API, mints + bcrypt-stores the secret
4. Operator copies the plaintext `ts_…` secret (shown once)
5. Customer pastes the secret into `TUNNEL_AUTH_TOKEN` in `.env`
6. Customer sets `CONNECTOR_NAME` to match the row's Name field exactly
7. Customer sets `CONTROLLER_URL`
8. Customer boots; first register-ack mints the `connectors` row; `registrationToken` lands in `.connector-state.json`

Steps 1–4 are operator work in the controller. Steps 5–7 are customer-side config in `.env`. Step 8 happens automatically.

**What survives if we adopt their AccountSid-as-identity approach:**
- Steps 1–5 collapse to "customer has a Twilio API Key already; paste AccountSid + ApiKey + ApiSecret into `.env`."
- Step 6 disappears entirely (the Host header *is* the name).
- Step 7 stays.
- Step 8 stays (we still want a `registrationToken` for the durable controller-side state — manifest + creds + approvals — that the relay doesn't have).

So the operator step (1–4) goes away for the single-connector-per-account case. That's the win.

### C. Verify-on-every-connect is overkill for us, but the "no separate secret to manage" property is the actual win

cai-relay re-hits Twilio REST on every connect because each connect is a fresh 5-min session. Our connector connects once and stays connected for weeks; doing a Twilio REST call on every reconnect would still be cheap, but it's not the interesting property.

The interesting property is: **the customer never has a secret that's specific to the relay**. They use credentials they already have from Twilio. No "go to the controller UI to mint a tunnel secret" step. That's worth copying even if we cache the verification result for the lifetime of the WS.

We could do this hybrid: on WS upgrade, if the bearer is a `ts_…` string, do the existing bcrypt lookup; if it's a Twilio API Key (starts with `SK`), do a one-time Twilio REST verify, cache the result for the connection lifetime, and key the in-memory session by the verified AccountSid. Two postures, picked by the prefix of what the customer pasted.

### D. TLS termination at the edge, not in the connector

The relay binary speaks plain HTTP and lets the ALB do TLS. We don't say much about TLS termination today because the connector is outbound-only — but the **controller** side (which *is* inbound) currently varies by deployment. The relay's pattern (ALB + wildcard ACM + DNS validation) is the canonical AWS shape and the same shape applies if/when we deploy the controller to AWS. Not a connector lesson per se, but a controller deployment lesson.

### E. What we should NOT borrow

- **3-session slot cap.** Their cap is to prevent one developer from saturating shared infra. We run one connector container per `tunnel.name`; multiplexing isn't a thing for us. If we ever add HA replicas behind one connector_id, revisit.
- **5-minute hard session timeout.** Their sessions are phone calls; ours are persistent tool channels. Hard-killing the WS after 5 minutes would break us.
- **No reconnect logic on the client.** Their developers redial manually because a phone call ending is a natural event. Our customers want 24/7 uptime; we *need* the backoff state machine we have.
- **No durable per-tenant state.** Their relay has nothing to remember between sessions. We have manifests, approvals, creds, webhook allocations — all of which need to survive a WS reconnect. The `MEMORY.md` entry on [in-memory state behind LB](file:///Users/dhartman/.claude/projects/-Users-dhartman-Development-01-Twilio-AgenticProcedure-mcp-shim/memory/feedback_inmemory_state_with_loadbalancer.md) captures why this is harder for us.

---

## Concrete proposal: "Twilio-account-anchored" mode

A reduced-config posture that lives alongside the existing one, picked per-customer:

### Customer-facing surface

`.env`:
```
CONTROLLER_URL=https://controller.example.com
TWILIO_ACCOUNT_SID=AC36375...
TWILIO_API_KEY=SK...
TWILIO_API_SECRET=...
```

That's it. No `CONNECTOR_NAME`, no `TUNNEL_AUTH_TOKEN`, no operator-side row creation. The customer pastes three values they already have from the Twilio console.

### Wire-level changes

WS upgrade headers:
```
Authorization: Basic <base64(SK...:secret...)>
X-Twilio-Account-Sid: AC36375...
```

Controller-side dispatch on upgrade:

1. If `X-Twilio-Account-Sid` is present → "anchored mode"
   - Call `GET https://api.twilio.com/2010-04-01/Accounts/{sid}.json` with the supplied Basic auth
   - 200 → accept; cache verification for the WS lifetime; bind session to a synthetic `connector_id = anchor:{sid}` (or `anchor:{sid}:{optional-suffix}` if the customer wants multiple per account)
   - Non-200 → 401
2. If `X-Connector-Name` is present → existing posture (lookup by name, bcrypt verify)

### What still needs a controller row

The `connectors` row mints on first register-ack, same as today, keyed by the synthetic `connector_id`. We keep durable per-connector state (approved drop-ins, webhook allocations, MCP roster generation, registration token). The *Tunnel Security Config row* disappears — that's the one whose only purpose is auth, and the Twilio API Key replaces it.

### Open questions

1. **Operator visibility.** Does the controller UI need a way to enumerate "all anchored connectors for AccountSid X"? Today the Tunnel Security row gives you a name to click on; in anchored mode, the row only exists once the connector first connects. Probably fine — list connectors by `connector_id`, group by AccountSid prefix in the UI.
2. **Per-account quota.** Should we cap how many anchored connectors a single AccountSid can mint? Their answer is "3, in Redis." Ours is probably "unlimited, but rate-limit the connect attempts to prevent runaway."
3. **OAuth2 path.** Anchored mode is fundamentally API-Key-based. OAuth2 customers stay on the named/row-based posture. That's fine — the two are mutually exclusive per `.env` already.
4. **Twilio-takeover story.** If Twilio takes over hosting the controller, anchored mode becomes the *only* posture that makes sense (every connector is anchored to its Twilio account by definition). The named/row-based posture stays around for self-hosted controllers where the customer is the operator.

---

## Action items

Not prioritized — flagged for follow-up.

1. **Anchored auth mode prototype.** Add the WS-upgrade dispatch branch on the controller side. Connector-side: add a `TWILIO_ACCOUNT_SID` env-var path in [packages/connector/src/auth/](packages/connector/src/auth/) that builds Basic auth from `TWILIO_API_KEY:TWILIO_API_SECRET` and sets `X-Twilio-Account-Sid` on the upgrade. The branch in [packages/connector/src/tunnel/client.ts:65-69](packages/connector/src/tunnel/client.ts#L65-L69) already has two postures — this becomes a third.
2. **Synthetic connector_id derivation.** Decide between `anchor:{sid}` (one per account) vs. `anchor:{sid}:{suffix}` (allow multiple). The latter is more flexible at the cost of needing a `CONNECTOR_SUFFIX` env var. Probably `CONNECTOR_NAME` reused, defaulting to `default` — same env var as today, optional in anchored mode.
3. **Twilio REST verify caching.** One verify per WS lifetime. If the WS lives for weeks, the verify result is cached for weeks. Acceptable because the credential check is "did this API Key exist when the WS opened" — credential revocation invalidates *future* connects, not existing ones, exactly like cai-relay's posture.
4. **Update [README.md](../../packages/connector/README.md) and the deploy docs.** Document the two postures and when to pick which: anchored for "customer with one Twilio account, wants minimum config"; named/row-based for "operator-managed fleet, multiple connectors, OAuth2, or non-Twilio identity."

## Status

- Draft, awaiting decision on whether to actually build anchored mode.
- Not gated on any other work.
- Mostly a controller-side change (new upgrade dispatch branch + synthetic connector_id derivation); the connector-side change is small (one new auth provider in [packages/connector/src/auth/](packages/connector/src/auth/)).




