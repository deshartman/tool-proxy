# Network access

Customer-facing walkthrough for making the connector's inspector reachable
from elsewhere on your network — not just via `kubectl port-forward` /
`docker exec`-style operator tunneling — with real authentication guarding
every non-loopback route. Off by default; nothing here changes behavior
until you opt in.

See also: [`INSPECTOR.md`](INSPECTOR.md#network-access) for the same flow
in the context of the rest of the inspector, and
[`ENV-VARS.md`](ENV-VARS.md) for why this feature adds zero env vars.

## Why you'd want this

Today, reaching the inspector at all requires operator-level infra access
(a kubeconfig, a docker socket, a cloud IAM role) to open a port-forward or
exec session. That's the right model for a human operator glancing at MCP
status. It's the wrong model for:

- A machine — some internal system that wants to trigger a Twilio action
  (place a call, send a message) through this connector directly, without
  a human in the loop.
- An operator who wants to reach the inspector UI from a normal browser on
  the corporate network, without a CLI tool in hand.

Network access adds a real authentication layer so the SAME server can
answer both of those, without giving up the loopback-only default.

## The two-tier trust model

1. **Loopback (`127.0.0.1` / `::1`) — always trusted, unconditionally,
   forever.** This never changes, regardless of whether network access is
   enabled. It's the permanent recovery path: if you ever lose the admin
   secret, port-forward or exec back in and rotate it from there.
2. **Everything else — needs a valid credential.** An admin session bearer
   for the operator UI, or an OAuth2 access token for the machine API.
   Before you've enabled network access, "everything else" can't reach the
   port at all — the connector still binds `127.0.0.1` only.

## Enable network access (operator UI)

One-time setup, from a session you already trust:

1. Reach the inspector the way you do today (port-forward / exec / cloud
   console). Complete Configure Tunnel and anything else you need, same as
   always.
2. In the **Network Access** panel, click **Enable network access**. This
   single click:
   - Mints a random admin secret and seals it at rest (same primitives
     that protect the tunnel bearer).
   - Persists that the feature is enabled — so it stays on across restarts.
   - **Shows you the plaintext secret once**, on that page. Copy it now —
     there is no way to view it again. If you lose it, port-forward back
     in and click **Rotate secret** for a fresh one.
   - Live-rebinds the inspector's listener to be reachable from elsewhere
     on the network. No restart.
3. From a different machine on your network, open the connector's address
   in a browser. You'll see a login screen, not the dashboard. Paste the
   secret you copied. The connector issues a session; the dashboard loads
   exactly as it does over loopback.

**Rotating the secret** (Network Access panel → **Rotate secret**, once
you're already logged in) invalidates the old value immediately and shows
you a new one, once. Existing browser sessions keep working — only future
logins need the new secret.

Whether the connector's port is actually reachable from elsewhere on your
network at all is a separate, infra-level decision (a K8s Service, a
security group rule, a Docker port mapping) — this feature only controls
what the *application* does once traffic can reach it. See the deploy
guides under [`deploy/`](../deploy/) for the opt-in wiring on each
platform (Helm's `networkAccess.enabled`, Fargate's security group note,
ACA's internal ingress, Compose's port mapping).

## Onboard a machine caller

Machine callers use OAuth2 `client_credentials` — no browser, no redirect,
just a `client_id`/`client_secret` pair exchanged for a short-lived bearer
token.

1. From an already-logged-in admin session, click **Add API client** in
   the Network Access panel. Optionally give it a label so you can tell
   integrations apart later.
2. The connector shows you a `client_id` and `client_secret` **once**.
   Store them in your machine caller's own secrets management — there is
   no way to retrieve the secret again (mint a new client if you lose it).
3. That caller exchanges the pair for an access token:

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

4. Attach `Authorization: Bearer <access_token>` to subsequent machine-API
   calls until it expires, then repeat step 3.

**Removing a client** (Network Access panel → **Remove**) blocks its next
`/oauth/token` attempt immediately. A token that client already holds
keeps working until its own (1 hour) expiry — there's no forced early
revocation of already-issued tokens in this version. If that's not
acceptable for your threat model, don't reuse a token beyond its stated
expiry, and remove a compromised client the moment you know about it.

### Federated mode

Instead of the connector minting its own credentials, you can point it at
your existing IdP: any validly-signed JWT from that issuer, with the right
audience claim, is accepted — no separate onboarding step in the
connector. Both modes can be active at once. Ask your Twilio contact if
you need this wired up for your deployment; it's not yet exposed as a
self-serve inspector action.

## What's not here yet

The machine-API route for triggering connector actions directly (e.g.
`outbound.place_call`) is still in progress — this document will be
updated with the exact request shape once it ships. Today, `/oauth/token`
issuance and the admin-session login flow are fully live; there is no
protected route to call with the resulting token yet beyond what the
operator UI itself uses.

## Troubleshooting

- **"I clicked Enable but I can't reach it from another machine."** Check
  whether the port is reachable at the infra layer at all (see the deploy
  guides linked above) — this feature only controls the application's own
  gate, not network routing, security groups, or firewalls.
- **"I lost the admin secret."** Port-forward / exec back in (loopback is
  always trusted) and click **Rotate secret**.
- **"My browser session logged out."** Sessions are in-memory and don't
  survive a connector restart — log in again with the current secret.
- **"A revoked API client's old token still works."** Expected — see
  "Onboard a machine caller" above. It'll stop working at its own expiry.
