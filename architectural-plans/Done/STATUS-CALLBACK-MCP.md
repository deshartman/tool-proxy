# STATUS-CALLBACK-MCP — Webhook ingress for MCPs over the existing tunnel

> **Status:** **done (2026-06-23)**. Connector side landed on `feature/status-callback-mcp` (2026-06-15); controller side landed on `feature/status-callback-mcp` in `AgenticProcedure/` the same day. `waitForStatus` body landed 2026-06-23 in [`mcp/bundled/twilio/status-callback.ts`](../../mcp/bundled/twilio/status-callback.ts) with peer test [`packages/connector/tests/mcp-tools/apis/status-callback-wait.test.ts`](../../packages/connector/tests/mcp-tools/apis/status-callback-wait.test.ts). Twilio sandbox round-trip verified 2026-06-23: SMS to +61401277115 with `receiveStatusCallbacks: true` produced both `sent` and `delivered` callbacks (sid `SM23269d2d…`) inbound through `/api/webhook/conn_72f733d7/cw_cwhead42d…`. All connector-side docs (README, CLAUDE.md, docs/deploy/README.md) updated. Companion brief for the controller side: [`STATUS-CALLBACK-CTRL.md`](../../../AgenticProcedure/.claude/plans/STATUS-CALLBACK-CTRL.md).
>
> ## Decisions (2026-06-15)
>
> - **SDK ↔ connector IPC.** Option (A) — bundled MCP children talk to the parent connector over the existing inspector loopback HTTP server (127.0.0.1:`INSPECTOR_PORT`). Two routes:
>   - `GET  /internal/webhook/stream?mcp=…` — SSE stream. Opening the stream IS the allocation. Emits `event: url` with the URL (and re-emits when the URL changes), `event: webhook` per inbound POST, `event: error` on failure. Closing the stream releases the allocation.
>   - `POST /internal/webhook/revoke` — explicit teardown for SDK consumers that want to release before the EventSource is torn down.
>   - No `/allocate` route — having a stream-as-allocation kept the SDK simpler than allocate+stream.
>   - Trust boundary is the localhost-only inspector port; no separate auth.
> - **Reopen behaviour.** Eager re-allocate. On `register-ack` success the registry calls `reallocateAll()`, dropping any cached URL and re-sending `webhook-allocate` for every MCP that still has a live SDK listener. The fresh URL is pushed to the SDK as a new `event: url` on its SSE stream.
> - **Example wire-up.** `mcp/bundled/twilio/` — `createWebhookEndpoint` is generic (any Twilio API that accepts a `statusCallback` URL works: Messages, Calls, Recordings, Conferences, Fax, Video). The Twilio MCP exports two helpers from `mcp/bundled/twilio/status-callback.ts`:
>   - `getDefaultStatusCallback()` — lazily allocates one shared URL for the MCP and reuses it for the lifetime of the child process.
>   - `onStatusCallback(listener)` — fanout for any inbound callback.
>   - `waitForStatus(sid, {timeout, until?})` — per-SID awaitable. **Stub left as a 5–10 line user contribution** — shape was approved but the body is intentionally unimplemented. See `mcp/bundled/twilio/status-callback.ts` for the TODO and constraints.
>   - `messages_create` is wired to consume `getDefaultStatusCallback()` when the caller passes `receiveStatusCallbacks: true` and no explicit `statusCallback` URL.
> - **Branch.** `feature/status-callback-mcp` (mirrors the plan filename, paired with the controller-side branch).
>
> ## What's landed in this branch
>
> | Surface | File(s) | State |
> |---|---|---|
> | Frame types | [`packages/connector/src/tunnel/frames.ts`](../../packages/connector/src/tunnel/frames.ts) | done — 4 new frames + 2 union members |
> | Allocation registry | [`packages/connector/src/tunnel/webhook-registry.ts`](../../packages/connector/src/tunnel/webhook-registry.ts) | done — subscribe/dispatch/revoke/onTunnelClose/reallocateAll |
> | Lifecycle wiring | [`packages/connector/src/index.ts`](../../packages/connector/src/index.ts) | done — frame router, register-ack hook, tunnel-close hook |
> | SDK IPC routes | [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) | done — `/internal/webhook/stream` + `/revoke`; webhooks snapshot streamed to UI |
> | SDK module | [`packages/connector/src/sdk/webhook.ts`](../../packages/connector/src/sdk/webhook.ts) + re-exports from `sdk/index.ts` | done — `createWebhookEndpoint` with `on('callback'|'url'|'error')` + `stop()` |
> | Inspector UI | [`packages/connector/public/index.html`](../../packages/connector/public/index.html), [`packages/connector/public/app.js`](../../packages/connector/public/app.js), [`packages/connector/public/style.css`](../../packages/connector/public/style.css) | done — Webhooks panel + frame summaries for the 4 new types |
> | Twilio MCP example | [`mcp/bundled/twilio/status-callback.ts`](../../mcp/bundled/twilio/status-callback.ts), [`mcp/bundled/twilio/server.ts`](../../mcp/bundled/twilio/server.ts), [`mcp/bundled/twilio/tools/messaging/messages_create.ts`](../../mcp/bundled/twilio/tools/messaging/messages_create.ts) | done — except `waitForStatus` body (user contribution) |
> | Docs | README.md, CLAUDE.md, docs/deploy/README.md | done — README "Receiving webhooks" subsection, CLAUDE.md frame list + two load-bearing-property bullets, docs/deploy/README.md "Webhook ingress" section. Per-cloud guides (aws/azure/gcp) audited and untouched — none mention controller routing today. |
> | End-to-end verify | controller-side branch + Twilio sandbox | pending — controller landed; needs a real Twilio sandbox round-trip with `feature/status-callback-mcp` connector + AgenticProcedure controller running side-by-side |
>
> ## Cross-plan reconciliation (2026-06-15)
>
> After both plans landed in their respective repos, the controller-side dev called out a set of mismatches. We accepted the controller's positions wholesale because the connector code is already correct on every point — the URL is opaque from our side, and our eager-reallocate path already pushes a fresh `event: url` to SDK consumers when the controller mints a new tail. Resolved here:
>
> | # | Item | Resolution |
> |---|---|---|
> | 1 | URL prefix | `/api/webhook/<connectorId>/<token>` (not `/webhook/...`). Controller decides; connector consumes verbatim. |
> | 2 | WS-down behaviour | Controller returns **503 with no buffer**. Twilio retries upstream. Buffering paragraph below removed. |
> | 5 | `ttlSeconds` on `webhook-allocate` | v1 controller **ignores** `ttlSeconds`; allocations live until `webhook-revoke` or row delete. Field stays in the wire format as reserved-for-future. |
> | 6 | URL stability across reconnects | URL **prefix** (rowId) is stable; **random tail re-mints** on each `webhook-allocate`. Pasted Twilio configs that match by prefix continue resolving; in-flight POSTs against the previous tail 401 briefly until Twilio retries with the new tail. |
> | 8 | Header forwarding allowlist | `X-Twilio-*` (case-insensitive prefix) + `Content-Type`. Strip everything else. |
> | 9 | Body size cap | 256 KB at the controller; 413 over. |
> | 10 | Cross-link path | Fixed (top of doc) to `../../../AgenticProcedure/.claude/plans/STATUS-CALLBACK-CTRL.md`. |
> | 11 | `Content-Type` is informational | Body is JSON-normalised on the controller. The forwarded `Content-Type` header in `WebhookFrame.headers` is informational only — MCP authors must NOT `JSON.parse(body)` (it's already an object/string per the original payload shape). Documented in [`packages/connector/src/sdk/webhook.ts`](../../packages/connector/src/sdk/webhook.ts) JSDoc. |
> | 12 | Inspector trust boundary | Inspector port is 127.0.0.1-only. The "Webhooks" panel exposes the FULL plaintext URL — that's by-design ergonomics for the connector author. **Never bridge the inspector port to a public LB**, since copying the URL out is the intended flow and the URL is the bcrypt-protected secret. Documented as a load-bearing property in [`CLAUDE.md`](../../CLAUDE.md). |
> | 13 | `mcp` value on `webhook-allocate` | The bundled Twilio MCP registers with `name: 'apis'`, not `'twilio'`. Plan examples that say `createWebhookEndpoint({ mcp: 'twilio' })` are aspirational — the **actual** value sent on the wire is whatever the MCP's `ServerDescriptor.name` is, which for the bundled Twilio MCP is `'apis'`. Verified end-to-end on 2026-06-15: the row in `mcp_webhook_endpoints` landed with `mcp_name = 'apis'`. Twilio author attestation lives on `manifest.servers[].author`, not on the MCP name. |

## Goal

Give bundled / customer-authored MCPs a way to receive **inbound HTTPS webhooks** (e.g. Twilio's payment `statusCallback`, voice/messaging callbacks, Conversation Relay events) without breaking the connector's outbound-only invariant. The current "ngrok per MCP" approach used by `@deshartman/mcp-status-callback` (sibling repo at `../twilio-mcp-servers/mcp-status-callback`) is correct in spirit but wrong for our architecture — it bypasses the trust model we just shipped in `feature/mcp-security`, requires customers to hold ngrok auth tokens, and only gives stable URLs on a paid plan.

We already have:
- a publicly-addressable component (the controller),
- a per-tunnel authenticated WS (the existing `/mcp-tunnel` socket, post-`feature/mcp-security`),
- a stable identity per connector (`connectorId` minted on first register-ack, persisted in `.connector-state.json`).

This plan reuses all three to deliver webhook ingress without ngrok.

## Architecture in one diagram

```
Twilio (or any webhook source)
   │
   │ HTTPS POST  https://<controller-host>/api/webhook/<connectorId>/<token>
   ▼
controller  ──forward as `webhook` frame──▶  connector  ──in-process emit──▶  bundled MCP
                  (existing WS)                (existing IPC to child)
   ▲
   │ HTTP 200 on success / 503 if WS down (no buffer, Twilio retries)
```

- **Connector still opens no inbound ports.** The "public URL" is on the controller; the connector consumes it over the WS that's already up. Outbound-only invariant preserved (verify against [CLAUDE.md "Architecturally load-bearing properties"](../../CLAUDE.md)).
- **Auth reuses the per-tunnel pattern.** The token in the URL is bcrypt-stored on the controller per-(connector, mcp), exactly mirroring `tunnel_security_configs` in shape; the connector never holds it long-term.
- **No new public infra to provision.** The controller already terminates `/crelay` and `/mcp-tunnel` on a single port — `/api/webhook/...` is a third path on the same listener.

## Checklist

### Connector core (this repo)

- [x] `frames.ts` — add four frame types (`webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke`)
- [x] Tunnel client / dispatcher — route `webhook` frames inbound by MCP name; route `webhook-allocate-ack` to the awaiting promise
- [x] Per-MCP allocation registry — track `(mcp → url, listener)`; surface in inspector
- [x] Graceful revoke on tunnel close (eager re-allocate on reopen). Revoke-on-yaml-reload-removing-an-MCP is moot today because `mcp_servers` changes already require a process restart (`sameMcpServers()` in `index.ts`)

### SDK surface (`@mcp-shim/connector/sdk`)

- [x] New helper `createWebhookEndpoint({ mcp })` — `endpoint.url`, `on("callback"|"url"|"error", …)`, `off`, `stop()`
- [x] Re-export from `packages/connector/src/sdk/index.ts`
- [x] Wired into `mcp/bundled/twilio/` as a generic helper (`getDefaultStatusCallback`, `onStatusCallback`, `waitForStatus` stub) used by `messages_create`

### Inspector UI

- [x] New "Webhooks" panel listing each MCP's allocated public URL with a copy button
- [x] Surface the new frame types in the Frames panel (`webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke` summaries)

### Docs (do not skip — CLAUDE.md guidance)

- [x] Update [`README.md`](../../README.md) — added a "Receiving webhooks" subsection under "Three ways to wire up an MCP" with the SDK ergonomics, URL contract, and no-inbound-port invariant.
- [x] Update [`CLAUDE.md`](../../CLAUDE.md) — added the four new frames to the "Wire protocol — frames" list (with a "Backpressure / shared WS" subsection covering no-per-frame-await, no-chunking, and webhook-vs-rpc latency); added two load-bearing-property bullets covering webhook ingress preserving the outbound-only invariant and the inspector port being 127.0.0.1-only.
- [x] Update [`docs/deploy/README.md`](../../docs/deploy/README.md) — added a "Webhook ingress" section explaining `/api/webhook/...` lives on the controller's existing hostname, no new DNS/TLS, and the connector deployment shape doesn't change. Reiterates "no LB in front of the connector" and adds "inspector port stays 127.0.0.1-only".
- [x] Audit [`docs/deploy/aws-fargate.md`](../../docs/deploy/aws-fargate.md), [`docs/deploy/azure-container-apps.md`](../../docs/deploy/azure-container-apps.md), [`docs/deploy/gcp-gke.md`](../../docs/deploy/gcp-gke.md) — none mention controller routing, no edits needed.

### Verification

- [x] `npm run build` clean (connector-side compiles, all new modules typed)
- [x] `waitForStatus` body landed in [`mcp/bundled/twilio/status-callback.ts`](../../mcp/bundled/twilio/status-callback.ts); peer test at [`packages/connector/tests/mcp-tools/apis/status-callback-wait.test.ts`](../../packages/connector/tests/mcp-tools/apis/status-callback-wait.test.ts) (5 cases: resolve, SID-mismatch ignore, until-predicate filter, timeout, concurrent awaiters)
- [x] End-to-end verified 2026-06-23: SMS via `messages_create` with `receiveStatusCallbacks: true` produced inbound `sent` + `delivered` webhook frames over the WS via `/api/webhook/conn_72f733d7/cw_cwhead42d…`. No ngrok process running on the connector side.

---

## Why we're not just adopting `@deshartman/mcp-status-callback`

That library is ~100 lines of real logic (sibling repo, `src/CallbackHandler.ts`):

1. Express app on auto-found port (4000+).
2. `ngrok.forward({ addr, authtoken, domain })` to mint a public URL.
3. Form-urlencoded → JSON normalisation on the body.
4. `EventEmitter` surface — `LOG`, `CALLBACK`, `TUNNEL_STATUS`.

Steps 1, 3, 4 are fine. Step 2 — ngrok — is the part that doesn't fit:

| Concern | ngrok-per-MCP (today's library) | Tunnel-via-controller (this plan) |
|---|---|---|
| Customer needs ngrok auth token? | Yes | No |
| Stable URL across restarts? | Paid ngrok only | Prefix stable (rowId follows `connectorId`); random tail re-mints |
| Auth on the public URL? | URL-obscurity | bcrypt'd per-MCP token |
| Connector opens inbound ports? | Yes (Express on 4000+) | No |
| Multiple MCPs per connector? | Each opens its own tunnel + Express | One controller endpoint, multiplexed by MCP name |
| Webhook ordering relative to tunnel state? | Independent — survives WS down | Tied to WS — controller 503s when WS is down (no buffer) |

The bottom-row caveat is real and **deliberate**: the controller does not buffer when the WS is down (no in-memory queue, no replay). It returns 503 to the upstream and relies on Twilio's documented retry policy. See "Open questions" below for why we accepted that trade-off.

## Wire protocol — four new frames

Add to [`packages/connector/src/tunnel/frames.ts`](../../packages/connector/src/tunnel/frames.ts).

```ts
// Connector → controller: "mint a public URL for this MCP".
export interface WebhookAllocateFrame {
  type: "webhook-allocate";
  // ServerDescriptor.name from the manifest — opaque to the controller,
  // used only as the (connector_id, mcp_name) uniqueness key. The bundled
  // Twilio MCP sends 'apis' here (matches its registered server name).
  mcp: string;
  ttlSeconds?: number; // RESERVED — v1 controller ignores this; allocations
                       // live until webhook-revoke or row delete.
}

// Controller → connector: response to webhook-allocate.
// Echo `mcp` so concurrent allocations can be matched without sequence numbers.
export interface WebhookAllocateAckFrame {
  type: "webhook-allocate-ack";
  mcp: string;
  url?: string;                       // present on success
  error?: { code: string; message: string };
}

// Controller → connector: a webhook arrived. Forwarded verbatim.
export interface WebhookFrame {
  type: "webhook";
  mcp: string;                        // routing key — controller looked this up by token
  queryParameters: Record<string, string | string[]>;
  body: unknown;                      // already JSON-normalised by the controller
  headers?: Record<string, string>;   // selected forwarded headers (e.g. X-Twilio-Signature)
  receivedAt: number;                 // ms epoch — when the controller logged the POST
}

// Connector → controller: clean up on shutdown / yaml reload that removed the MCP.
export interface WebhookRevokeFrame {
  type: "webhook-revoke";
  mcp: string;
}
```

Update the unions at the bottom of `frames.ts`:

```ts
export type TunnelFrame =
  | RegisterFrame
  | ManifestDeltaFrame
  | RpcFrame
  | HeartbeatFrame
  | GoodbyeFrame
  | WebhookAllocateFrame      // new
  | WebhookRevokeFrame;       // new

export type InboundTunnelFrame =
  | TunnelFrame
  | RegisterAckFrame
  | WebhookAllocateAckFrame   // new
  | WebhookFrame;             // new
```

### Why echo `mcp` on the ack instead of an opaque `requestId`

Allocation is per-MCP, idempotent, and rare. A connector won't have two concurrent `webhook-allocate` calls for the *same* MCP — and across MCPs, the `mcp` field is sufficient to disambiguate. Saves us a sequence-number / pending-promise table and matches the existing `register-ack` shape (no `requestId` there either).

## Connector implementation sketch

### 1. Allocation registry

New module `packages/connector/src/tunnel/webhook-registry.ts`:

```ts
export interface WebhookAllocation {
  mcp: string;
  url: string;
  listener: (frame: WebhookFrame) => void;
}

export class WebhookRegistry {
  private byMcp = new Map<string, WebhookAllocation>();
  private pendingAllocs = new Map<string, (ack: WebhookAllocateAckFrame) => void>();
  // ... allocate(mcp, listener), revoke(mcp), dispatch(frame), onAck(frame)
}
```

Lifecycle:
- `allocate(mcp, listener)` — sends `webhook-allocate`, awaits ack, stores `(mcp → url, listener)`, returns the URL. If the ack is an error, throws.
- `dispatch(frame: WebhookFrame)` — looks up by `frame.mcp`, invokes listener. Unknown MCP → log warn + drop (don't NACK; controller can't replay anyway).
- `revoke(mcp)` — sends `webhook-revoke`, removes from map.
- `onClose()` — clears local state but does **not** send `webhook-revoke` (the WS is gone; controller will GC by `connectorId` session).
- `onReopen()` — re-allocate any URLs that callers are still subscribed to. The controller will mint a fresh random tail (rowId is stable); the connector treats the URL as opaque and pushes the new value to SDK consumers as a fresh `event: url` on their SSE stream.

### 2. Dispatcher wiring

In [`packages/connector/src/index.ts`](../../packages/connector/src/index.ts), the existing frame router (handles `rpc`, `register-ack`, `goodbye`) gets two new cases:

```ts
if (frame.type === "webhook-allocate-ack") return webhookRegistry.onAck(frame);
if (frame.type === "webhook")             return webhookRegistry.dispatch(frame);
```

### 3. SDK surface

New file `packages/connector/src/sdk/webhook.ts`:

```ts
export interface WebhookEvent {
  /**
   * Already JSON-normalised by the controller. For form-urlencoded upstream
   * POSTs, `body` is the parsed object — DO NOT call JSON.parse on it. The
   * `Content-Type` in `headers` reflects the upstream's original value but is
   * informational only by the time the MCP sees this event.
   */
  body: unknown;
  queryParameters: Record<string, string | string[]>;
  /**
   * Allowlisted forwarded headers — `X-Twilio-*` (case-insensitive prefix) +
   * `Content-Type` only. Repeated headers are comma-joined (Node's default).
   */
  headers?: Record<string, string>;
  receivedAt: number;
}

export interface WebhookEndpointOptions {
  mcp: string;  // must match the MCP's registered name
}

export interface WebhookEndpoint {
  url: string;
  on(event: "callback", listener: (e: WebhookEvent) => void): void;
  off(event: "callback", listener: (e: WebhookEvent) => void): void;
  stop(): Promise<void>;
}

export function createWebhookEndpoint(opts: WebhookEndpointOptions): Promise<WebhookEndpoint>;
```

The implementation talks to the connector's `WebhookRegistry` via a process-local IPC channel (the bundled / Type 1 MCP runs as a *child* of the connector — they share neither memory nor the WS). Two viable channels:

- **(A) HTTP loopback.** The connector exposes a tiny 127.0.0.1-only endpoint on the existing inspector port (`GET http://127.0.0.1:<inspectorPort>/internal/webhook/stream?mcp=…`, an SSE stream where opening the connection IS the allocation). Simple, no new auth surface — the inspector port is already 127.0.0.1-only and the trust boundary is the loopback interface.
- **(B) Reverse-channel via the existing MCP HTTP transport.** The SDK piggybacks on the StreamableHTTPServerTransport that the spawner already wires up. Cleaner topology but harder to thread because that transport is request/response-shaped.

**Chose (A).** The inspector port is already a localhost-only HTTP server inside the connector ([`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) is the pattern); adding `/internal/webhook/stream` (SSE) and `/internal/webhook/revoke` (POST) routes was trivial and kept the SDK thin. There is no `/allocate` route — opening the SSE stream IS the allocation; the URL arrives as the first `event: url` (and is re-emitted on every reconnect-driven re-mint).

**Trust boundary note.** The inspector also surfaces the full plaintext webhook URL in its "Webhooks" panel (operator-facing copy button). That's by design — the panel is the authoritative way for an MCP author to retrieve their URL. Because the URL is the bcrypt-protected secret, **the inspector port must never be bridged to a public LB or proxied off-host**. This invariant should land alongside the existing "no inbound public ports on the connector" load-bearing property in [CLAUDE.md](../../CLAUDE.md).

Re-export from `packages/connector/src/sdk/index.ts`.

### 4. Author-facing usage (target shape)

```ts
// inside an MCP's server.ts
import { createWebhookEndpoint } from "@mcp-shim/connector/sdk";

// `mcp` MUST match the MCP's registered ServerDescriptor.name — the
// bundled Twilio MCP registers as "apis", not "twilio".
const cb = await createWebhookEndpoint({ mcp: "apis" });
cb.on("callback", ({ body, queryParameters, headers }) => {
  // store in payment-status map, etc.
});

// pass cb.url into the Twilio API call as the statusCallback parameter
await twilio.calls(callSid).payments.create({ statusCallback: cb.url, ... });
```

Drop-in replacement for the `CallbackHandler` API in the sibling repo, minus the ngrok config.

## Inspector UI changes

In [`packages/connector/public/app.js`](../../packages/connector/public/app.js):

- New panel: **Webhooks** — table of `(mcp, url, allocatedAt, last hit at)` with copy-to-clipboard on URL.
- The existing **Frames** filter chip list gets a `webhook` chip.

## Reconnect semantics

Webhook allocation is **session-scoped on the controller side** (per [`STATUS-CALLBACK-CTRL.md`](../../../AgenticProcedure/.claude/plans/STATUS-CALLBACK-CTRL.md)) and the URL **prefix** (rowId) is stable as long as `connectorId` is stable; the **random tail** re-mints on each `webhook-allocate`. Concretely:

| Event | Controller behaviour | Connector behaviour |
|---|---|---|
| First-connect | Mints new `(connectorId)` row; no webhooks yet | — |
| Connector calls `createWebhookEndpoint({mcp})` | Mints a per-(connectorId, mcp) row, stores bcrypt'd token, returns URL | Stores allocation, returns URL to MCP author |
| Connector reconnects with same token | Existing webhook **row id** stays; URL random tail **re-mints** each `webhook-allocate`. Pasted Twilio configs that match by prefix continue working; in-flight POSTs against the previous tail 401 briefly until Twilio retries with the new tail. | Eager `reallocateAll()` on register-ack — re-sends `webhook-allocate` for any currently-subscribed MCPs; SDK consumers see a fresh `event: url` on their SSE stream. |
| Connector clears `.connector-state.json` (operator action) | New `connectorId` row, old webhook rows orphaned (controller GCs by session) | Loses old URLs; MCP authors must re-call `createWebhookEndpoint` |
| WS down, webhook arrives | Controller returns **503**; no in-memory buffer | Connector receives nothing — Twilio retries upstream per its documented webhook retry policy |

Webhook ordering is **best-effort, last-write-wins** at the MCP level (matches the sibling repo's `statusCallbackMap` semantics). When the WS is down, the controller does not queue — Twilio's retry behaviour is the safety net, not us.

## Backpressure / ordering

Pure `webhook` frames now share the WS with `rpc` traffic and heartbeats. Two things to watch:

1. **Heartbeat starvation.** Today `policy.heartbeat_interval_ms` defaults to a small interval; a burst of webhook frames could push heartbeat past the deadline. **Mitigation:** the WS client already serialises `send()` synchronously; heartbeats stay fair as long as we don't introduce a per-frame await. Keep `webhook` framing identical to `rpc` (one JSON line per frame, no chunking) and we're fine.
2. **Webhook latency vs RPC latency.** Twilio's payment callbacks are not latency-sensitive (humans say digits). Voice TwiML callbacks *can* be — the call leg waits for our response. **Mitigation:** controller is the synchronous HTTP responder; it returns 200 immediately on receipt and forwards async over the WS. The MCP child sees a slight delay vs ngrok-direct, but the upstream (Twilio) doesn't.

If either becomes a real problem we have escape valves — separate WS, frame-priority, etc. — but don't pre-build them.

## Trust boundary

Webhook tokens are **per-MCP, per-connector**. The controller bcrypts them at rest (mirror of `tunnel_security_configs.secret_hash`). The connector receives the plaintext `url` once on `webhook-allocate-ack` and holds it in memory for the session; it is NOT persisted to `.connector-state.json` (re-mintable on reconnect).

If a customer ever wants per-tool gating ("MCP X may receive webhooks but not Y"), the controller's existing `connectors` UI is the right surface — the connector enforces nothing here. Same precedent as the tool-allowlist decision documented in [CLAUDE.md "Trust boundary is per MCP server, not per tool"](../../CLAUDE.md).

## Open questions — RESOLVED (2026-06-15, accepted from controller plan)

- **Header forwarding policy.** ✅ Forward `X-Twilio-*` (case-insensitive prefix) plus `Content-Type` verbatim. Strip everything else (notably `Authorization`, `Cookie`, `Host`, `X-Forwarded-*`). The Twilio MCP needs `X-Twilio-Signature` for webhook validation; the prefix-match captures every Twilio context header without us maintaining an exhaustive list.
- **Body size cap.** ✅ 256 KB at the controller. Over → controller returns **413** to the upstream (no fragmentation, no buffering). Frame size on the WS is bounded by the same cap so `rpc` traffic isn't displaced.
- **Form-urlencoded normalisation.** ✅ Done on the **controller**. MCPs always see JSON in `WebhookFrame.body` regardless of upstream `Content-Type`. The `Content-Type` header from the original POST is forwarded in `headers` but is informational by the time the frame arrives — note this in the SDK docstring.
- **WS-down behaviour.** ✅ Controller returns **503**, no in-memory buffer. Twilio's documented retry policy is the safety net. Customers running durable webhooks should add their own DLQ at the source (Twilio supports this via Functions / Studio).
- **`ttlSeconds` on `webhook-allocate`.** ✅ v1 controller ignores it. Allocations live until `webhook-revoke` or session end. Field stays in the wire format as reserved-for-future.

## Files this plan touches

| File | Change |
|---|---|
| [`packages/connector/src/tunnel/frames.ts`](../../packages/connector/src/tunnel/frames.ts) | +4 frame types, +2 union members |
| [`packages/connector/src/tunnel/webhook-registry.ts`](../../packages/connector/src/tunnel/webhook-registry.ts) | new file |
| [`packages/connector/src/index.ts`](../../packages/connector/src/index.ts) | +2 frame router cases, lifecycle hooks |
| [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) | +internal `/webhook/*` routes for SDK IPC |
| [`packages/connector/src/sdk/webhook.ts`](../../packages/connector/src/sdk/webhook.ts) | new SDK module |
| [`packages/connector/src/sdk/index.ts`](../../packages/connector/src/sdk/index.ts) | re-export |
| [`packages/connector/public/app.js`](../../packages/connector/public/app.js) | new Webhooks panel + frames filter chip |
| [`README.md`](../../README.md) | "Receiving webhooks" subsection |
| [`CLAUDE.md`](../../CLAUDE.md) | wire-protocol frame list; load-bearing-property note |
| [`docs/deploy/README.md`](../../docs/deploy/README.md) | controller-side public-hostname note |
