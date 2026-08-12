# Network access

Customer-facing walkthrough for the machine API — letting a script or
automation call this connector's `/oauth/token` endpoint directly, without
a human in the loop. This is the ONLY thing that's ever reachable from
outside the host. The operator dashboard itself has no login and never
will — it's loopback-only, unconditionally, forever, same as it always
was. Off by default; nothing here changes behavior until you add an API
client.

See also: [`INSPECTOR.md`](INSPECTOR.md#network-access) for the same
model in the context of the rest of the inspector.

## Why you'd want this

Today, reaching the inspector at all requires operator-level infra access
(a kubeconfig, a docker socket, a cloud IAM role) to open a port-forward or
exec session. That's the right model for a human operator glancing at MCP
status, and it never changes. It's the wrong model for a machine — some
internal system that wants to trigger a Twilio action through this
connector directly, without a human clicking through a UI first.

Adding an API client gives that machine its own revocable credential and
makes exactly one endpoint, `/oauth/token`, reachable from wherever that
machine lives on your network. Nothing else about the connector's surface
changes.

## The trust model

1. **Loopback (`127.0.0.1` / `::1`) — always trusted, unconditionally,
   forever.** The dashboard, tool calls, tunnel config, API-client
   management — every operator-facing route — only ever answers to
   loopback. This never changes, regardless of how many API clients
   exist. There is no way to reach the dashboard from off-box, and no
   opt-in that changes that.
2. **Everything else — reaches nothing except `/oauth/token`.** Once at
   least one API client exists, that one endpoint answers non-loopback
   requests too, authenticated by the caller's own `client_id`/
   `client_secret` — never by anything to do with the dashboard.

## Add an API client

Machine callers use OAuth2 `client_credentials` — no browser, no
redirect, just a `client_id`/`client_secret` pair exchanged for a
short-lived bearer token.

1. From the inspector (reached the way you always do — port-forward /
   exec / cloud console), open the **Network Access** panel and click
   **Add API client**. Optionally give it a label so you can tell
   integrations apart later.
2. The connector shows you a `client_id` and `client_secret` **once**, in
   the right pane. Store them in your machine caller's own secrets
   management — there is no way to retrieve the secret again (mint a new
   client if you lose it).
3. **The first client you ever add** also flips on non-loopback
   reachability for `/oauth/token` — live, in-process, no restart. Every
   client after that is just another credential; the endpoint is already
   reachable.
4. That caller exchanges the pair for an access token:

   ```bash
   curl -s -X POST https://<connector-address>:9090/oauth/token \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d 'grant_type=client_credentials' \
     -d "client_id=$CLIENT_ID" \
     -d "client_secret=$CLIENT_SECRET"
   ```

   ```json
   { "access_token": "eyJ...", "token_type": "Bearer", "expires_in": 3600 }
   ```

5. Attach `Authorization: Bearer <access_token>` to subsequent machine-API
   calls until it expires, then repeat step 4.

Whether the connector's port is actually reachable from elsewhere on your
network at all is a separate, infra-level decision (a K8s Service, a
security group rule, a Docker port mapping) — this feature only controls
what the *application* does once traffic can reach it. See the deploy
guides under [`deploy/`](../deploy/) for the opt-in wiring on each
platform (Helm's `networkAccess.enabled`, Fargate's security group note,
ACA's internal ingress, Compose's port mapping).

**Removing a client** (Network Access panel → **Remove**) blocks its next
`/oauth/token` attempt immediately. A token that client already holds
keeps working until its own (1 hour) expiry — there's no forced early
revocation of already-issued tokens in this version. If that's not
acceptable for your threat model, don't reuse a token beyond its stated
expiry, and remove a compromised client the moment you know about it.

Client ID and Client Secret are always shown redacted in the list view;
the Copy button next to each copies the real underlying value, not the
masked text on screen.

### Federated mode

Instead of the connector minting its own credentials, you can point it at
your existing IdP: any validly-signed JWT from that issuer, with the right
audience claim, is accepted — no separate onboarding step in the
connector, and no per-client allowlist here (who's allowed to call,
revocation, and audit stay entirely with your own IdP). Both modes can be
active at once; the connector picks the right verifier by the token's own
`alg` header (HS256 → self-issued, RS256 → federated).

Configure it self-serve from the inspector's **Network Access** panel, in
the **Federated JWT** sub-section: fill in three fields —

- **Issuer (`iss`)** — the `iss` claim your IdP stamps on its tokens, e.g.
  `https://idp.example.com`.
- **JWKS URL** — where the connector fetches your IdP's public signing keys,
  e.g. `https://idp.example.com/.well-known/jwks.json`. Keys are cached for
  5 minutes, so a rotation at your IdP is picked up automatically.
- **Audience (`aud`)** — the `aud` claim the connector requires, e.g.
  `mcp-connector`.

None of the three are secret (they're public IdP metadata), so they're shown
verbatim, not redacted. Click **Save**. Just like adding your first API
client, **setting a trusted issuer for the first time also flips on
non-loopback reachability** for the machine API — so a customer who only ever
uses federated mode (and never mints a self-issued client) still gets the
`/v1/*` routes reachable from the rest of their network. **Clear**
removes the config; like every widening in this feature it does not re-narrow
the bind.

## Machine API routes

There are three protected routes beyond `/oauth/token` itself:

| Route | What it does | Reference |
|---|---|---|
| `POST /v1/outbound/calls` | Trigger a real outbound Twilio call or message through the tunnel. | [`OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) |
| `POST /v1/identity/list` | Browse, search, **and resolve** the account's identities. **Returns bulk PII** — see the note below. | [`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §5 |
| `POST /v1/memory/events` | Tell an agent something out of band — one note into its working memory for a given identity. | [`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) |

A fourth, `POST /v1/identity/find`, existed briefly and is **gone**: the
controller merged it into `identity.list`, whose `identifier` is a substring, and
an exact address is a substring of itself. Its path is no longer allowlisted, so a
non-loopback call to it now gets a `403` like any other unknown path.

Attach the bearer token from step 4 above to any of them:

```bash
curl -s -X POST https://<connector-address>:9090/v1/outbound/calls \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"place_call","to":"+15551234567","agentId":"agt_123","channelId":"chn_456"}'

# Memory injection is two calls: resolve, then write.
curl -s -X POST https://<connector-address>:9090/v1/identity/list \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identifier":"+15551234567"}'
# -> {"result":{"identities":[{"identityId":"identity_9f2c1a04-...","aliases":[...],...}]}}   or   {"identities":[]}

curl -s -X POST https://<connector-address>:9090/v1/memory/events \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agt_123","identityId":"identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13","event":"your flight is delayed"}'
```

For outbound, `action` is `"place_call"` or `"send_message"`; full
request/response shape and error codes are in
[`OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) §3/§5.

For memory, the write body is
`{agentId, identityId, event, occurredAt?, ttlSeconds?, idempotencyKey?}` — see
[`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §2/§10. Two things to know: **it takes an
`identityId`, not an address** (resolution is a separate lookup-only call, so a
typo can't mint a phantom customer), and **`agentId` is required** because
working memory is keyed per agent.

On `list`, `channel` is optional — it only narrows. **`identifier` is a
case-insensitive substring, so a full address can match several identities**
(`des@example.com` also matches `des@example.com.au`). Don't take
`identities[0]`; compare against each result's `aliases` and pick the exact one —
see [`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §2.

An empty `identities: []` is a normal `200`, not an error: it means you have a
customer this account has never interacted with. Put your fact in the outbound
call's `callContext` instead — see [`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §4.

All three routes use the same `machine-api:<clientId>` audit-trail identity on the
wire, and **the same bearer works on all of them**: either a self-issued (HS256)
token from `/oauth/token` or a federated (RS256) token from your own IdP once
you've configured a trusted issuer above. Each route accepts both, and the
caller doesn't need to know or care which one was verified.

**`/v1/identity/list` deserves a second look before you hand out a
credential.** It's the only route here that returns bulk customer PII — every
alias value on every identity in the account — rather than performing one
targeted action, and it has no server-side cap (omit `limit` and you get the
whole set). The gate is the same as the others and account scoping is enforced
controller-side, but the blast radius of a leaked bearer is now "enumerate the
customer base", not just "dial or inject". If a given integration only ever needs
to write, it never needs to call this route — credential scoping is the lever
here, since bearers are per-API-client and revocable.

Enumeration isn't silent, either: the controller's audit rows record the number
of identities each call returned, so a credential sweeping the account leaves a
visible trail rather than looking like ordinary lookups.

One operational note if you call `list` over a large account: raise `timeoutMs`
rather than retrying. A timeout returns nothing (never a partial), and there's no
way to cancel the query already running on the controller — so a retry loop
stacks abandoned full-account scans while you see only failures. See
[`MEMORY-EVENTS.md`](MEMORY-EVENTS.md) §5.

## Troubleshooting

- **"I added a client but can't reach `/oauth/token` from another
  machine."** Check whether the port is reachable at the infra layer at
  all (see the deploy guides linked above) — this feature only controls
  the application's own gate, not network routing, security groups, or
  firewalls.
- **"Can I reach the dashboard from another machine?"** No, and there's
  no setting that changes that — the dashboard is loopback-only,
  unconditionally. Reach it the way you always have (port-forward / exec).
- **"A revoked API client's old token still works."** Expected — see
  "Add an API client" above. It'll stop working at its own expiry.
- **"I pointed ngrok (or a similar local tunnel) at the inspector port
  and the dashboard loaded anyway."** Expected, and important: a tunnel
  agent that runs on the SAME machine as the connector (ngrok, `ssh -R`,
  etc.) makes its forwarded requests to `http://localhost:<port>` — a
  genuine loopback connection from the connector's point of view,
  indistinguishable from `kubectl port-forward` or `docker exec`. Free-
  tier ngrok has no auth of its own by default, so pointing it at this
  port without ngrok's own gate (`ngrok http <port> --basic-auth
  "user:pass"`) publishes the whole dashboard to the internet. This is
  unrelated to how many API clients exist — a localhost-forwarding tunnel
  reaches a loopback-only bind just as easily as a non-loopback one.
