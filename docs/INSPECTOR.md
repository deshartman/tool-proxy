# Inspector

> The inspector is the connector's local web UI. It binds to `127.0.0.1:9090` (port configurable via `INSPECTOR_PORT`) by default, renders live state, and exposes per-MCP operator actions. Loopback access is **always trusted, unconditionally, forever** — that never changes. It carries the bcrypt-protected webhook URL with a copy button by design, and the SDK ↔ connector IPC routes carry no auth of their own beyond the per-MCP webhook token.
>
> Network access is a **separate, explicit, off-by-default opt-in**: an admin can click "Enable network access" from a trusted loopback session to make the SAME server reachable from elsewhere on the customer's network, behind a real authentication layer (an admin secret + session for the operator UI, OAuth2 `client_credentials` for machine callers). See [Network access](#network-access) below. Until that opt-in has happened, this doc's older framing still applies in full: **never bridge `INSPECTOR_PORT` to a public load balancer.**

Open it at <http://localhost:9090/> (or via SSH port-forward / `kubectl exec` from a deployed container).

## Layout

The inspector has a **left column** (panels) and a **right pane** (detail view). The left column is draggable; the width persists in `localStorage`.

```
┌─ Header ─────────────────────────────────────────────┐
│ controllerId · environment · version · WS state pill │
├──────────────────┬───────────────────────────────────┤
│ MCP Server       │  ← right pane: tool shape         │
│   tool A   Ready │  ← OR: prompt detail              │
│   tool B  ⚠️Awaiting │  ← OR: resource URI               │
│ Available Tools  │  ← OR: MCP creds form (W-S5)      │
│ MCP Status       │  ← OR: frame detail               │
│ Webhooks         │                                   │
│ Frames           │                                   │
└──────────────────┴───────────────────────────────────┘
```

The right pane reflects whatever you most recently clicked in the left column — clicking a tool, prompt, resource, MCP name, or frame all switch the right pane. There is no close button: clicking another item replaces the view.

## Panels

### MCP Server (per-server tree)

One card per running MCP. Click the **grey "MCP SERVER" header** to expand/collapse the tool list. Click the **purple `<name>`** to open the MCP creds view in the right pane (see [Right pane — MCP creds view](#right-pane--mcp-creds-view) below). Cards default collapsed; expansion state persists in `localStorage`.

Each card shows:
- The MCP name (purple) and transport (e.g. `http · 7 tools · 1 prompt · 1 resource`).
- **Available Tools** — every tool the MCP advertised, with a verdict pill:
  - **Ready** — the tool is callable.
  - **Awaiting config** — the MCP declared `envKeys` and no creds are set. The Run button (in the right-pane tool view) is disabled until creds arrive.
- **Prompts** and **Resources** sections (when the MCP advertised those capabilities).

### Available Tools (legacy flat list)

A flattened list of every tool across every MCP, with the same Ready / Awaiting config verdicts as the per-server tree. Useful for skimming the full tool surface when several MCPs are running.

### MCP Status

One row per MCP, with:
- **Process state** — running / stopped / restarting / permanently-failed (state-coloured left border).
- **Source badge** — `yaml` (Twilio-shipped, listed in `connector.yaml`), `local` (drop-in folder under `MCP_DROPIN_DIR`), or `controller` (3rd-party MCP pushed over the tunnel).
- **Awaiting config** badge — fires when the MCP declared `envKeys` but no creds are set. Same predicate as the per-tool verdict downgrade. Disappears once creds are applied (controller or session).
- **creds** line — `controller` / `controller+session` / `session` / `dir/.env` / `none`, plus a "N seconds ago" timestamp.
- **tools** count.
- **restarts** count + last reason (e.g. `creds-update`, `manual`, `session-creds-expired`).
- **mcpId** when the MCP came from the controller (3rd-party MCP roster).
- Click the MCP's name to open its message history (every request sent and response / notification received) in the right pane. Each entry shows collapsed by default (timestamp, direction, method) — click it to expand the full JSON payload at full height, click again to collapse. History persists across selections until **Restart** or **Clear** is clicked.
- Three action buttons:
  - **Reload creds** — re-fetch creds from the controller. Restarts the child if values change.
  - **Restart** — re-spawn the child with current env. Resets the consecutive-failure counter. Also clears the message-history log.
  - **Clear** — wipes the message-history log only, without touching the child process.

### Webhooks

One row per MCP that called `createWebhookEndpoint`. Shows the bcrypt-protected public URL with a **copy** button — operators paste it into Twilio configs (statusCallback, recording callbacks, etc.). The URL prefix is stable across reconnects; the random tail re-mints on every `webhook-allocate`.

> **Trust boundary:** the URL *is* the secret. The inspector binds to `127.0.0.1` for exactly this reason — anyone with access to the inspector port has access to copy-able webhook URLs. Never bridge to an LB.
>
> **Two additional auth layers gate the inspector routes despite the loopback bind:**
> 1. **CSRF guard** on every state-changing POST — requires `Content-Type: application/json` AND `X-Inspector-Request: 1` header. Prevents a browser tab the operator has open from silently firing state-changing requests to `127.0.0.1:9090`.
> 2. **Per-MCP webhook token** on `/internal/webhook/stream` and `/revoke` — the connector mints a fresh 32-byte token per MCP at spawn, injects it as `MCP_WEBHOOK_TOKEN` in the child's env, and the inspector constant-time-compares the caller's `Authorization: Bearer <token>` against that per-MCP value. Prevents sibling drop-ins in the same container from eavesdropping on each other's webhook events.
>
> Static-asset responses also carry a strict `Content-Security-Policy` (no `unsafe-eval`, `frame-ancestors 'none'`, `default-src 'self'`), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` as defense-in-depth against XSS regressions.

### Frames

Live ring buffer of every WS frame in/out. Filterable by type; heartbeats hidden by default. Click a frame to open its full payload in the right pane.

Includes the W-S4 / W-L2 / W-E2 frame additions:
- `creds-request` / `creds-response` / `creds-update` (controller-driven creds)
- `webhook-allocate` / `webhook-allocate-ack` / `webhook` / `webhook-revoke` (webhook ingress)
- `mcp-config-snapshot` / `mcp-config-delta` / `mcp-config-resync` (3rd-party MCP roster)
- `local-mcps-rescan` / `local-mcps-rescan-ack` (Refresh local MCPs)
- `mcp-notification` (server-initiated notifications)

The Frames panel never includes session-pasted creds — those don't ride the tunnel and don't generate frames.

## Right pane — MCP creds view

Click the **purple `<name>`** on any MCP server card to open the creds view in the right pane. The view shows:

- **Creds source pill** — `controller` / `controller+session` / `session` / `dir/.env` / `none`, sourced from `McpStatus`.
- **Expiry countdown** — when session creds are active, ticks down from 12h.
- **Note** — context-aware ("Controller-set creds active", "Session creds active", or "No creds configured").
- **Form** — one masked input per declared envKey (read live from `GET /mcp/env-keys?mcp=<name>`).
  - Keys that already have a session value get a green `SET` badge next to the label and a `•••••••• (set — leave blank to keep)` placeholder. The connector NEVER echoes the value back through the loopback UI; the placeholder is a literal string and the input renders empty.
- **Apply (session only)** — POSTs to `/mcp/session-creds-apply` with `mode: "merge"` semantics. Only the keys you typed into get overwritten; keys marked `SET` survive untouched if you leave the field blank. Values land in supervisor RAM, child restarts. Form clears immediately after submit so the pasted secret doesn't sit in DOM memory.
- **Clear session creds** — POSTs to `/mcp/session-creds-clear`; supervisor drops the entire session layer, child restarts. Clear is the way to remove a single set key (paste a fresh value over it via Apply, or Clear and start over).

### What session creds are for

Session creds are the **developer's local feedback loop**. After dropping a folder under `mcp/local/<name>/` you'd otherwise have to wait for an admin to paste creds in the controller UI before you could smoke-test your tool. Session creds let you paste your own dev creds directly into the inspector — values live in connector RAM only, expire after 12 hours, and never persist to disk or cross to the controller.

### Precedence

Session creds layer **below** controller-supplied creds in the env merge:

```
process.env  ⊕  spec.env (yaml inline + dir/.env)  ⊕  sessionEnv  ⊕  controllerEnv
                                                                    ↑ controller wins per-key
```

If the controller has a value for `TWILIO_AUTH_TOKEN`, that's what the child sees — the session-pasted value is ignored *for that key*. Session creds usefully fill *gaps* the controller hasn't covered.

### What never leaks

The session creds view is built around a strict no-leak contract. Pinned by the test pack at [`connector/tests/inspector/session-creds-leak.test.ts`](../connector/tests/inspector/session-creds-leak.test.ts):

- Pasted values **never** appear in any HTTP response from the inspector (apply, clear, env-keys, events, frames, manifest).
- Pasted values **never** appear in pino log lines (the logger has a redact config; runtime backstop for accidental `log.info({env}, ...)` slips).
- Pasted values **never** persist to disk — no `.env` file written, no state file touched.
- The form is **always empty** on render; controller-set values never echo back through the loopback UI.
- The `McpStatus` snapshot exposed via `/events` SSE carries only `credsSource` + `sessionCredsExpiresAt`, never the values.

If you find a leak, that's a **bug** — file an issue or rerun the leak test pack to reproduce.

## HTTP endpoints

The inspector exposes a small set of HTTP routes. From the loopback bind, **every one of these is unauthenticated** — the trust boundary there is the loopback bind itself, exactly as it's always been. Once "Enable network access" has been clicked (see [Network access](#network-access)), a caller reaching these SAME routes from anywhere else needs a valid admin session bearer or, for the machine-API routes, an OAuth2 access token — see [Machine API](#machine-api).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`            | Static UI (`index.html`) — always public, even non-loopback (it's the login screen when unauthenticated) |
| `GET`  | `/app.js`, `/style.css` | Static assets — always public |
| `GET`  | `/events`      | Server-Sent Events stream of inspector state. Non-loopback: session token travels as `?token=` (EventSource can't set headers) |
| `POST` | `/reconnect`   | Re-read YAML and redial the controller |
| `POST` | `/mcp/reload-creds` | Re-fetch creds for one MCP from the controller |
| `POST` | `/mcp/restart` | Restart one MCP child |
| `POST` | `/mcp/rescan-local` | Re-scan `MCP_DROPIN_DIR` (W-L2 inspector entry) |
| `POST` | `/mcp/session-creds-apply` | Apply developer-pasted session creds (W-S4) |
| `POST` | `/mcp/session-creds-clear` | Drop the session creds layer (W-S4) |
| `GET`  | `/mcp/env-keys?mcp=<name>` | List declared envKeys (read-only) |
| `GET`  | `/mcp/messages?mcp=<name>` | Read one MCP's message-history log (read-only) |
| `POST` | `/mcp/messages/clear` | Clear one MCP's message-history log (doesn't touch the child) |
| `POST` | `/tool/call`   | Invoke a tool through the same dispatch path the controller uses |
| `GET`  | `/internal/webhook/stream?mcp=<name>` | SDK ↔ connector IPC: SSE stream of webhook events |
| `POST` | `/internal/webhook/revoke` | SDK ↔ connector IPC: explicit teardown |
| `POST` | `/internal/network-access/login` | Exchange the admin secret for a session bearer — always public (that's the point) |
| `POST` | `/internal/network-access/enable` | Mint (if absent) the admin secret, persist `enabled=true`, live-rebind non-loopback. Reveals the plaintext once |
| `POST` | `/internal/network-access/rotate` | Regenerate the admin secret; reveals the new plaintext once |
| `GET`  | `/internal/network-access/status` | `{enabled, hasSecret}` |
| `POST` \| `GET` | `/internal/network-access/clients` | Mint / list machine-API `client_id`+`client_secret` pairs ("Add API client") |
| `POST` | `/internal/network-access/clients/revoke` | Revoke a machine-API client |
| `POST` | `/oauth/token` | Machine API — `grant_type=client_credentials` token exchange. Always public (self-authenticates via the body) |

The session-creds routes are **write-only** by design. There is no `GET /mcp/session-creds` — the inspector never reads back values, ever. Same convention for the admin secret and machine-API client secrets: `enable` / `rotate` / `clients` reveal their plaintext exactly once in the response body, never again.

## Reconnect button

Top-right header. Re-reads `connector.yaml` and dials the controller again. Picks up `policy` changes (e.g. heartbeat interval); does **not** pick up changes to `mcp_servers` (those need a process restart).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `INSPECTOR_PORT` | `9090` | TCP port; binds to loopback only by default |
| `INSPECTOR_BIND_ADDR` | `127.0.0.1` | Bind address. Loopback set: `127.0.0.1` / `::1` / `localhost`. Any other value requires `INSPECTOR_ALLOW_NONLOOPBACK=1`. |
| `INSPECTOR_ALLOW_NONLOOPBACK` | (unset) | Set to `1` to acknowledge a non-loopback bind. Required for Fly.io deployments using `::` behind the WireGuard mesh (with `fly ips list` empty). Reserved for that case only — unrelated to "Enable network access" below, which needs no env var at all. |
| `LOG_LEVEL` | `info` | Pino log verbosity |

## Troubleshooting

- **"My tool shows Awaiting config but I want to call it."** Open the MCP creds view (click the purple name) and paste your dev creds, OR ask an admin to set them in the controller UI. Tools without `envKeys` never enter the awaiting state.
- **"Session creds disappeared."** They expire 12h after paste. Re-paste — the timer resets on re-apply, not on activity.
- **"Webhook URL changed."** Expected — the random tail re-mints on every `webhook-allocate` (e.g. on connector reconnect). The prefix is stable across reconnects, so pasted Twilio configs that match by prefix continue resolving.
- **"I want to test from a remote machine."** Two options: `ssh -L 9090:localhost:9090 <connector-host>` / `kubectl port-forward` (no setup, always available, loopback trust), or click "Enable network access" once and reach the port directly with a login (see below) — pick the latter only if you actually need non-operator, non-tunneled reachability (e.g. a machine caller hitting `/oauth/token`).

## Network access

Off by default. The full setup flow, once per connector instance:

1. Reach the inspector the way you do today — port-forward / `docker exec` / cloud-console exec — gated by whatever platform credential already gates that (kubeconfig RBAC, docker socket access, cloud IAM). No new credential needed for this step.
2. From that trusted loopback session, click **"Enable network access"** in the new Network Access panel. This one action, atomically:
   - Generates a random admin secret (if one doesn't already exist) and seals it at rest the same way the tunnel bearer is sealed.
   - Persists `network_access_enabled = true`.
   - **Shows the plaintext once**, in that same browser page — never in a log line.
   - **Live-rebinds** the inspector's listener from `127.0.0.1` to reachable-from-elsewhere, in-process — no container/process restart.
3. **Loopback access never changes.** A request from `127.0.0.1` / `::1` is always trusted, forever, regardless of whether network access is enabled — the permanent recovery path if the admin secret is ever lost.
4. A fresh browser hitting the network-reachable URL with no session sees a login screen, not the dashboard. It POSTs the secret to `/internal/network-access/login`; on match the connector issues an opaque session bearer, stored by the browser and attached to every subsequent request (`Authorization: Bearer <token>`, or `?token=` for the one route — `/events` — that can't carry custom headers).
5. **State persists across restarts.** If `network_access_enabled` is already `true` in Postgres, the next boot binds non-loopback directly — the loopback-first-then-enable sequence above is one-time setup, not something repeated on every restart.
6. **Rotate secret** (same panel, once already authenticated) regenerates the secret, reseals it, shows the new plaintext once, and invalidates the old value immediately. Existing sessions are unaffected — only future logins need the new value.

No env var is involved anywhere in this flow — it's entirely DB/UI-driven, deliberately, so rotation and onboarding never require a redeploy.

## Machine API

A second, independent credential shape lives on the same server for non-human callers — no browser, no redirects, `client_credentials` grant (OAuth2 §4.4):

- **Self-issued (default).** The connector is its own token issuer. From an authenticated admin session, click **"Add API client"** to mint a `client_id`/`client_secret` pair (shown once). That pair exchanges for a short-lived HS256 JWT via `POST /oauth/token` (`grant_type=client_credentials`) — standard OAuth2 request/response shape, including RFC 6749 §5.2's `invalid_client` error body for a wrong secret or unknown client (deliberately indistinguishable, so a client-enumeration attempt learns nothing).
- **Federated.** The connector can instead trust a customer's real IdP directly — same signature/`iss`/`aud`/`exp` verification, just against that IdP's JWKS instead of the connector's own signing key. The caller's `client_credentials` exchange happens against the customer's IdP, never this connector.
- **Revoking a client** ("Remove API client" in the same panel) blocks its *next* `/oauth/token` attempt immediately. It does not force-expire a JWT that client already holds — that JWT stays valid until its own (short) natural expiry. There's no token-revocation list in this version; if that's a problem for your threat model, keep the access-token lifetime short.

## Cross-references

- [`AUTHOR-LOCAL-MCP.md`](AUTHOR-LOCAL-MCP.md) — write a Type 1 drop-in MCP and smoke-test it with session creds.
- [`MCP-PROTOCOL.md`](MCP-PROTOCOL.md) — wire-format contract between connector and controller.
- [`BUNDLES.md`](BUNDLES.md) — Type 3 bundles in the current image.
- [`../CLAUDE.md`](../CLAUDE.md) — connector architecture overview, including the load-bearing trust boundary that makes the inspector loopback-only.
