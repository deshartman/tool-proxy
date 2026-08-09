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
connector. Both modes can be active at once. Ask your Twilio contact if
you need this wired up for your deployment; it's not yet exposed as a
self-serve inspector action.

## Machine API routes

Today there's one protected route beyond `/oauth/token` itself:
**`POST /v1/outbound/calls`** — triggers a real outbound Twilio call or
message through the tunnel. Attach the bearer token from step 4 above:

```bash
curl -s -X POST https://<connector-address>:9090/v1/outbound/calls \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"place_call","to":"+15551234567","agentId":"agt_123","channelId":"chn_456"}'
```

`action` is `"place_call"` or `"send_message"`; full request/response shape,
error codes, and the `machine-api:<clientId>` audit-trail identity this
route uses are documented in [`OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) §7.
Only self-issued (HS256) bearers are accepted by this route today —
federated-mode tokens aren't wired up for it yet even where federated mode
itself is configured.

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
