# MCP-PROTOCOL — Connector ↔ Controller wire format

> **Audience.** This document is the contract between the customer-side **MCP connector** and the **controller**. It specifies every frame the connector sends or accepts on the `/mcp-tunnel` WSS, and the controller-side behaviour the connector relies on.
>
> **Authority.** This is the authoritative wire-format spec. Plans (e.g. [.claude/plans/MCP-LOADING.md](../.claude/plans/MCP-LOADING.md)) describe *intent*; this document is what each side actually implements. If a frame is described here, it MUST be implemented per the schema below; if it is not described here, it MUST NOT be sent without first updating this doc.
>
> **Version.** v1 — additions covered by this revision: `creds-request`, `creds-response`, `creds-update`. Pre-existing frames (`register`, `register-ack`, `manifest-delta`, `rpc`, `heartbeat`, `goodbye`, `webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke`) are documented in [packages/connector/src/tunnel/frames.ts](../packages/connector/src/tunnel/frames.ts) and [CLAUDE.md](../CLAUDE.md). This document focuses on the new frames; older frames are linked in §"Pre-existing frames" for orientation only.

## Transport

- **Single WSS** at `wss://<controller-host>/mcp-tunnel`. Connector dials out; controller never dials in.
- **Frames are line-delimited JSON.** No chunking, no streaming binary, no per-frame await on send. Controller caps body size at 256 KB (HTTP 413 above that ceiling); the same limit is the implicit cap on tunnel frame size.
- **Authentication.** Established at WS-upgrade time via `Authorization: Bearer <bearer>` and `X-Connector-Name: <name>` headers. The controller looks up the `tunnel_security_configs` row by `(tenant_id, name)` and verifies the bearer (static `ts_…` token, or OAuth2 JWT). Per-frame auth is NOT required after the upgrade succeeds — every frame is implicitly scoped to the WS-authenticated `connectorId`.
- **Identity.** After upgrade, the connector sends a `register` frame with its `manifest`, `name`, and (on subsequent connects) `registrationToken`. The controller binds the session to a `connectors` row and replies with `register-ack`.

## Frame envelope

Every frame is a JSON object with a discriminator field `type`. Unknown frame types MUST be logged and ignored on both sides — never disconnect the WS for an unrecognized frame. This is what allows additive evolution.

```ts
interface Frame {
  type: string;          // discriminator
  // ... type-specific payload fields
}
```

## Controller responsibilities — summary

A controller implementing v1 of this protocol MUST be able to:

1. **Authenticate the WS upgrade.** Verify `Authorization: Bearer <bearer>` against the `tunnel_security_configs` row keyed by `(tenant_id, X-Connector-Name)`. Reject mismatches with HTTP 401. Derive `connectorId` from the matched row + register-frame flow; never trust frame-supplied connectorIds.

2. **Reply to every `creds-request` within ~1s.** Reply shape is always `creds-response` with a matching `requestId`. If the controller has no row for `(connectorId, mcp)`, reply with `{ env: {}, source: "none" }` — this is NOT an error, it's the documented "no row yet" reply. The connector treats it as "creds not available; child registers no tools."

3. **Auto-fill `author: "twilio"` requests** from the per-org Twilio credentials it already holds (typically the tunnel-security row). See §"Twilio-bundled auto-fill" — the connector relies on this so customers never enter Twilio creds twice. The mapping is restricted to authentication credentials only; per-call operational values (phone numbers, service SIDs) are tool arguments, not env.

4. **Push `creds-update` whenever creds change.** Operator-driven UI edits and tunnel-security rotation MUST both produce a `creds-update` frame. The connector restarts the child with the new env on receipt — that's the *only* way creds reach a running MCP child today, since bundled MCPs no longer read a local `.env`.

5. **Honour per-MCP scoping.** Every `creds-request` lookup MUST be scoped by the WS-authenticated `connectorId` AND the frame's `mcp` field — never `(connectorId, *)` or `(*, mcp)`. See §"Per-MCP scoping (CRITICAL — security-relevant)".

6. **Handle empty manifests cleanly.** A creds-gated MCP boots with zero tools when its required keys are absent (see §"Conditional tool registration"). Its `manifest.servers[]` entry will list `tools: []`. The controller's UI MUST surface this as "MCP exists but has no tools yet — supply credentials" rather than treating it as broken.

7. **Process `manifest-delta` frames as the source of truth for live tool changes.** When the connector restarts a child after a `creds-update`, the child's tool list may grow (creds arrived → tools register) or shrink (creds removed → tools unregister). The connector emits a `manifest-delta` frame on every such transition; the controller MUST update its tool index accordingly. This is the load-bearing signal for "creds → tool availability."

8. **Tolerate unknown frame types.** Log and ignore — never close the WS. This rule is symmetric with the connector's behaviour and is what allows additive evolution of the protocol.

9. **Audit operator actions.** Every UI edit that produces a `creds-update`, every `creds-request` received, and every WS-upgrade attempt SHOULD write to the controller's existing audit log (see §"Audit logging").

The frames below specify the wire shape that supports each responsibility.

## New frames added in v1

### `creds-request` (connector → controller)

The connector asks the controller for environment variable values to pass to a specific MCP child process.

```ts
interface CredsRequestFrame {
  type: "creds-request";
  requestId: string;       // UUID v4, generated by the connector
  mcp: string;             // MCP server name (matches manifest.servers[].name)
  author: "twilio" | "customer";   // matches manifest.servers[].author
  envKeys: string[];       // union of envKeys declared by tools in this MCP
                           // (may be empty if no tool declared envKeys)
}
```

**Controller MUST:**
1. Derive `connectorId` from the WS-authenticated session. **NEVER** trust a connector-supplied connectorId — the connector does not include one.
2. Look up the `(connectorId, mcp)` row in its credentials table.
3. If no row exists, auto-create one with `env: {}` and the supplied `envKeys` as the surfaced-required-keys hint in the controller UI.
4. Reply with a `creds-response` carrying the same `requestId`.
5. For `author == "twilio"`, fill the response from the `tunnel_security_configs` row used to authenticate this WS — see §"Twilio-bundled auto-fill" below.
6. Write a row to the controller's audit log: `{connectorId, mcp, action: "creds-request", at: <timestamp>}`.

**Controller SHOULD:**
- Reply within 1s for the connector's 5s soft-wait at boot to be useful.
- Surface unknown / newly-created `(connectorId, mcp)` rows in the controller UI's connector-detail view so the operator notices an MCP that needs creds.

### `creds-response` (controller → connector)

The controller's reply to a `creds-request`.

```ts
interface CredsResponseFrame {
  type: "creds-response";
  requestId: string;       // echoes the request's requestId
  env?: Record<string, string>;    // env values to merge into the child's env
  source?: CredsSource;    // where these creds came from
  error?: string;          // human-readable error if env cannot be supplied
}

type CredsSource =
  | "twilio-tunnel-row"    // auto-filled from tunnel_security_configs row
  | "operator-entered"     // entered in the controller UI
  | "none";                // no row exists yet (env will be {} or absent)
```

**Allowed shapes:**
- Success: `{ type, requestId, env, source }` — `env` may be `{}` if `source: "none"` (operator hasn't entered creds yet). This is **not** an error — connector falls back to `dir/.env`.
- Error: `{ type, requestId, error }` — used for unexpected controller-side failures (DB unreachable, etc.). Connector logs and falls back to `dir/.env`.

**Connector behaviour on receipt:**
1. Match `requestId` against pending requests; drop if unknown.
2. If `env` is present: merge into the spec's per-entry env map (controller-supplied wins on conflict).
3. If supervisor already spawned this child with stale env: restart with the new merged env.
4. If supervisor has not yet spawned (still inside the 5s soft-wait at boot): keep the new env in the spec; spawn picks it up.
5. Update inspector status: `credsSource = "controller (" + source + ")"`, `credsLastUpdated = now()`.

### `creds-update` (controller → connector)

The controller pushes new creds to the connector — typically because the operator updated them in the controller UI.

```ts
interface CredsUpdateFrame {
  type: "creds-update";
  mcp: string;             // MCP server name
  env: Record<string, string>;     // new env values to merge
  source: CredsSource;     // typically "operator-entered" or "twilio-tunnel-row"
  reason?: string;         // optional human-readable reason for the audit log
}
```

**Controller MUST:**
1. Send `creds-update` whenever an operator action changes creds for `(connectorId, mcp)`.
2. Send `creds-update` whenever a Twilio-bundled MCP's tunnel-security-row creds change (e.g. AccountSid rotation, AuthToken rotation, OAuth2 client rotation). In this case `source: "twilio-tunnel-row"`.
3. Write the operator action to the audit log before sending the frame, so that audit precedes effect.

**Connector behaviour on receipt:**
1. Look up the running spec for `mcp`. If unknown (controller is pushing for an MCP we don't run), log `warn` and ignore.
2. Merge `env` into the spec's per-entry env map.
3. Restart the child via the live MCP supervisor (Workstream B) with the new merged env.
4. Emit `manifest-delta` if the restart changes which tools are available.
5. Update inspector status fields.

## Twilio-bundled auto-fill

When `creds-request` arrives with `author == "twilio"`, the controller fills the response from the `tunnel_security_configs` row used to authenticate this WS:

| envKey requested | Filled from | When |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | row.accountSid | Always (every posture has it) |
| `TWILIO_AUTH_TOKEN` | row.authToken | Posture: Auth Token |
| `TWILIO_OAUTH_CLIENT_ID` | row.oauthClientId | Posture: OAuth2 (FUTURE — flagged for revision) |
| `TWILIO_OAUTH_CLIENT_SECRET` | row.oauthClientSecret | Posture: OAuth2 (FUTURE — flagged for revision) |

**Rules:**
- Only keys *requested* via `envKeys` get filled. The controller does NOT shotgun every Twilio key.
- Missing keys (e.g. `TWILIO_AUTH_TOKEN` requested on an OAuth2-posture row) are simply absent in the response. The connector logs a `warn` and the MCP runs without that key — same outcome as today's missing-`.env` case.
- `source: "twilio-tunnel-row"` lets the inspector status panel show "from Twilio creds — synced when row rotates."
- The Twilio-bundled MCPs only consume `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` today. The API-Key-posture row (which the controller still accepts at create time for tunnel-handshake verification) does NOT auto-fill any Twilio bundle env — customers on the API-Key posture must either also provide an AuthToken on the row for bundled MCPs to work, or run a sibling Auth-Token row for the connector.

**Out of scope — operational values are NOT auto-filled.** The tunnel-security row models *authentication credentials only*. Per-call operational values — phone numbers (`from`), Messaging / Verify Service SIDs, sender emails, agent IDs — are caller-supplied as tool arguments, not env vars. Twilio bundled tools do not declare these keys in `envKeys` and the controller does not store them. If a future feature needs to provision operational values, it should ride a separate frame (or a separate field on `creds-response`) rather than overload this row.

**Controller storage is implementation-defined; `source: "twilio-tunnel-row"` is informational.** This document specifies the *wire shape* of the auto-fill response — it does not mandate which controller-side row physically holds the values. A controller MAY source `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from any per-org credential surface (a tunnel-security row, an org-settings row encrypted at rest, an external secret manager, etc.) so long as the lookup is scoped to the WS-authenticated `connectorId` per §"Per-MCP scoping". The `source: "twilio-tunnel-row"` discriminator stays on the wire for backwards-compat and remains informational — the connector's inspector renders it as "from Twilio creds — synced when the source rotates" and treats the value opaquely. Controllers that store creds elsewhere SHOULD still emit `"twilio-tunnel-row"` (rather than coining a new value) until a future protocol revision adds finer-grained source enums.

## Per-MCP scoping (CRITICAL — security-relevant)

The controller MUST scope every `creds-request` lookup by the WS-authenticated `connectorId`. The connector never supplies its own connectorId in `creds-request`. This closes the cross-connector creds-leak path: connector A cannot trick the controller into returning connector B's CRM creds, even if both connectors declared an MCP named `crm`.

Implementation rule for the controller side:
```sql
SELECT env FROM mcp_credentials
WHERE connector_id = $authenticatedConnectorId  -- from WS session
  AND mcp_name      = $framePayload.mcp;
```

NEVER `WHERE connector_id = $framePayload.connectorId` — the frame has no such field.

## Boot timing — spawn-then-restart with 5s soft-wait

The connector does NOT block boot waiting for `creds-response`. Instead:

1. Send `register` → wait for `register-ack` (existing flow).
2. Send `creds-request` for every MCP in `manifest.servers`, in parallel.
3. Wait up to **5 seconds** for `creds-response` frames. Merge each into the appropriate spec's env as it arrives.
4. After the soft-wait OR all responses received (whichever comes first):
   - Spawn (or restart) every MCP via the supervisor with the merged env.
5. Late `creds-response` frames (arriving after the soft-wait): supervisor restarts the affected child with the new env. Same code path as `creds-update`.

This avoids two failure modes:
- **Slow controller stalls boot** (rejected: "block on creds" approach).
- **Stdio child crash-loops because boot never starts** (rejected: same reason).

## Conditional tool registration (creds-gated MCPs)

Bundled and Type 1 MCPs MAY register tools conditionally based on env presence. The Twilio-bundled `apis` MCP does this: it requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `SENDGRID_API_KEY`, and registers all 20 tools when present, zero when any is missing.

Two protocol-visible consequences:

1. **An MCP may show `tools: []` in `manifest.servers`.** This is a normal "creds not yet supplied" state, not an error. The controller's UI SHOULD render this distinctly from "MCP exists with tools" — "supply credentials to enable tools" is the intended message.

2. **Tool count changes over time.** When the controller pushes `creds-update` with the missing keys, the supervisor restarts the child; the child registers tools this time; the connector emits a `manifest-delta` to the controller. Conversely, when the operator removes creds, the next restart yields an empty tool list and the connector emits a delta removing them.

**Server-level `envKeys` declaration.** A creds-gated MCP MUST declare its required keys at the server level (`createMcpHttpServer({ envKeys: [...] })`), not just per-tool. Why: when no tools are registered, per-tool aggregation is empty; the connector's `creds-request` would advertise zero envKeys; the controller would have nothing to fill in even when its tunnel-security row holds the right values. The server-level declaration is what tells the controller *what to populate* before any tool exists. The SDK aggregator at [packages/connector/src/sdk/http-server.ts](../packages/connector/src/sdk/http-server.ts) prefers server-level over per-tool when both are set.

**Why "all-or-nothing" gating, not per-tool.** The Twilio bundle ships with a single trust boundary (Twilio + SendGrid creds belong to the same org / tunnel-security posture). Mixing partial creds — e.g. Twilio works, SendGrid doesn't — would surface 16 working tools and 4 broken ones in the controller, with the broken ones returning an error envelope per call. The bundle-level "all keys present or zero tools" rule trades partial functionality for clearer operator UX. Customer-authored MCPs are free to choose either policy; the protocol supports both.

## No local `.env` for the Twilio bundle (rolling out)

**Status: live for `mcp/bundled/twilio/` only as of this revision.** Other bundled and customer-authored MCPs still use the `dir/.env` fallback today; they will migrate to the same shape incrementally. The controller-side rules below apply per-MCP, not connector-wide — controllers MUST be prepared for this state on the Twilio bundle right now and on additional MCPs over time.

The Twilio-bundled MCP no longer reads `mcp/bundled/twilio/.env` for boot validation. All credentials reach the child *only* through the controller's `creds-response` / `creds-update` frames. Implications for controllers:

- **First-boot path is "creds-request → empty reply → empty manifest → operator fills row → creds-update → restart → full manifest."** A controller MUST NOT assume creds are pre-populated by the connector image; it MUST be prepared to push `creds-update` to a child whose tool list is currently `[]`.
- **An operator deleting a row MUST emit `creds-update` with `env: {}` and `source: "none"`.** That triggers the supervisor restart that empties the tool list — without the frame, the connector would keep using the stale env until next reconnect.
- **Customer-authored MCPs and not-yet-migrated bundles still honour `dir/.env`.** The connector's per-spec env precedence (process.env ⊕ dir/.env ⊕ yaml inline ⊕ controllerEnv) is unchanged. Controllers SHOULD treat `dir/.env` as transitional and aim to source every credential through `creds-update` over time.

## Backwards compat — older controllers

A controller that doesn't yet implement `creds-request` will:
- Receive the frame; either log + ignore (per "unknown frames" rule) or reply with an unknown-frame error frame.
- Either way: no `creds-response` arrives within 5s.

The connector's behaviour:
1. Log `warn` per affected MCP: `creds-request timed out, falling back to dir/.env`.
2. Spawn / restart the child using just `dir/.env` (today's behaviour).
3. Keep the WS open. **This is not a fatal protocol error.**

This means rolling out controller-side support can be done independently of connector rollout. Once the controller supports the frames, existing connectors get creds; until then they keep working.

**Twilio-bundle caveat.** Because the Twilio `apis` bundle no longer reads a `dir/.env` fallback (see §"No local `.env` for the Twilio bundle (rolling out)"), an older controller that never replies `creds-response` leaves the Twilio bundle in its empty-tools state indefinitely. Customer-authored and not-yet-migrated bundled MCPs are unaffected (their `dir/.env` still works). The fix is to upgrade the controller — there is no `dir/.env` workaround for the Twilio bundle by design. As more MCPs migrate, this caveat extends to them.

## Frame loss / retry

- The connector does NOT retry `creds-request` automatically on timeout. The 5s soft-wait + fallback covers boot. For runtime, the operator can press "Reload creds" in the inspector to force a fresh round-trip.
- The connector MUST be tolerant of duplicate `creds-update` frames (idempotent: same env → no-op restart). Controller bugs that double-send shouldn't crash-loop the child.
- The controller MAY re-send `creds-update` if it loses confidence the connector applied the previous one (e.g. after a WS reconnect from the controller side). Connector idempotency makes this safe.

## `envKeys` declaration — per-tool and server-level

The connector advertises the union of `envKeys` an MCP needs in its `creds-request.envKeys` payload. There are two declaration shapes; an MCP author picks whichever matches its registration pattern.

**Per-tool (default).** Each tool can declare its own keys; the SDK aggregates and de-dupes them.

```ts
// packages/connector/src/sdk/tool.ts
export interface Tool {
  name: string;
  envKeys?: string[];   // optional; env vars this tool needs
  register(server: McpServer): void;
}
```

**Server-level (required for creds-gated MCPs).** When tools register conditionally on creds presence (see §"Conditional tool registration"), per-tool aggregation is empty until creds arrive — the controller would have nothing to fill in. Pass `envKeys` to `createMcpHttpServer` directly:

```ts
await createMcpHttpServer({
  name: "apis",
  tools,                                              // possibly []
  envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY"],
});
```

When both shapes are set, **server-level wins** (it's the authoritative declaration). The SDK aggregator: [packages/connector/src/sdk/http-server.ts](../packages/connector/src/sdk/http-server.ts).

Authoring guidance:
- Declare every env var the tool/server reads at runtime.
- DON'T declare env vars the SDK reads (`PORT`, `INSPECTOR_PORT`) — those are connector-runtime, not tool-runtime.
- Twilio-shipped tools declare the standard Twilio keys (`TWILIO_ACCOUNT_SID`, etc.); the controller's auto-fill picks them up. The Twilio bundle uses **server-level** declaration because it gates registration on creds.

The connector union de-dupes: if 5 tools each declare `DB_URL`, `creds-request.envKeys` lists it once.

## Examples

### Boot — happy path

Customer `crm` MCP with two tools, one declares `DB_URL`, the other declares `DB_URL` and `API_TOKEN`.

```jsonc
// connector → controller
{ "type": "register", "name": "prod-east", "manifest": { /* ... */ }, "registrationToken": "..." }

// controller → connector
{ "type": "register-ack", "connectorId": "conn_abc123" }

// connector → controller (one per MCP, sent in parallel)
{
  "type": "creds-request",
  "requestId": "11111111-1111-1111-1111-111111111111",
  "mcp": "crm",
  "author": "customer",
  "envKeys": ["DB_URL", "API_TOKEN"]
}

// controller → connector
{
  "type": "creds-response",
  "requestId": "11111111-1111-1111-1111-111111111111",
  "env": { "DB_URL": "postgres://prod-db/crm", "API_TOKEN": "tk_..." },
  "source": "operator-entered"
}
```

Connector spawns the `crm` child with merged env: `process.env ⊕ dir/.env ⊕ yaml inline ⊕ {DB_URL, API_TOKEN}`.

### Boot — Twilio bundled MCP

```jsonc
// connector → controller — server-level envKeys lists ALL three even when no
// tools are registered yet (the bundle gates registration on creds presence).
{
  "type": "creds-request",
  "requestId": "22222222-2222-2222-2222-222222222222",
  "mcp": "apis",
  "author": "twilio",
  "envKeys": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY"]
}

// controller → connector — auto-filled from the per-org Twilio creds (and
// SendGrid creds, if also tracked). source is informational; see the note in
// §"Twilio-bundled auto-fill".
{
  "type": "creds-response",
  "requestId": "22222222-2222-2222-2222-222222222222",
  "env": {
    "TWILIO_ACCOUNT_SID": "AC...",
    "TWILIO_AUTH_TOKEN": "auth_token_here",
    "SENDGRID_API_KEY": "SG..."
  },
  "source": "twilio-tunnel-row"
}
```

Operator never had to enter Twilio creds twice.

### Boot — Twilio bundled MCP, controller has no row yet (creds-gated)

This is the cold-start flow when an operator hasn't filled the Twilio row yet. The bundle boots, advertises zero tools, and waits for `creds-update` to populate it — see §"Conditional tool registration" and §"No local `.env` for the Twilio bundle (rolling out)".

```jsonc
// connector → controller (same envKeys advertisement as above)
{
  "type": "creds-request",
  "requestId": "33333333-3333-3333-3333-333333333333",
  "mcp": "apis",
  "author": "twilio",
  "envKeys": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY"]
}

// controller → connector — no row yet; documented "no creds available" reply
{
  "type": "creds-response",
  "requestId": "33333333-3333-3333-3333-333333333333",
  "env": {},
  "source": "none"
}

// connector spawns/keeps `apis` running with empty env. Bundle's gating
// logic registers ZERO tools. manifest.servers reflects this:
//   { "name": "apis", "author": "twilio", "tools": [] }

// ─── operator fills the row in the controller UI ───
// controller → connector
{
  "type": "creds-update",
  "mcp": "apis",
  "env": {
    "TWILIO_ACCOUNT_SID": "AC...",
    "TWILIO_AUTH_TOKEN": "auth_token_here",
    "SENDGRID_API_KEY": "SG..."
  },
  "source": "twilio-tunnel-row",
  "reason": "Twilio creds entered by operator alice@example.com"
}

// connector restarts the apis child with the new env. The child registers
// all 20 tools this time. Connector emits a manifest-delta:
{
  "type": "manifest-delta",
  "delta": {
    "added":   [/* all 20 apis tools */],
    "removed": [],
    "changed": []
  }
}
```

The reverse path (operator deletes the row) sends `creds-update` with `env: {}` + `source: "none"`, supervisor restarts, child registers zero tools, connector emits a delta with all 20 in `removed`.

### Boot — older controller (timeout fallback)

```jsonc
// connector → controller
{ "type": "creds-request", "requestId": "...", "mcp": "crm", ... }

// (5s pass; no response)

// connector logs:
//   warn: creds-request for "crm" timed out — falling back to dir/.env

// connector spawns crm with env: process.env ⊕ dir/.env ⊕ yaml inline (no controller layer)
```

### Runtime push — operator updates AccountSid

```jsonc
// controller → connector (no requestId — controller-initiated)
{
  "type": "creds-update",
  "mcp": "apis",
  "env": { "TWILIO_ACCOUNT_SID": "AC_NEW...", "TWILIO_AUTH_TOKEN": "new_token" },
  "source": "twilio-tunnel-row",
  "reason": "AccountSid rotated by operator alice@example.com"
}
```

Connector restarts the `apis` child with the new env. Inspector shows: `credsLastUpdated: now()`, `lastRestartReason: "creds-update"`.

### Runtime push — unknown MCP

```jsonc
// controller → connector (controller pushed for an MCP we don't run)
{ "type": "creds-update", "mcp": "ghost-mcp", ... }

// connector logs:
//   warn: creds-update received for unknown MCP "ghost-mcp" — ignoring
```

No restart, no error, WS stays open.

## Audit logging — split between sides

| Action | Audited where |
|---|---|
| Operator enters creds in controller UI | Controller's existing audit log |
| `creds-request` arrives | Controller (connectorId, mcp, at) |
| `creds-update` sent | Controller (connectorId, mcp, operator, at) |
| Connector applies new env via supervisor restart | Connector log line: `mcp=<name> creds_version_changed restart=true` |
| Frame seen on the wire | Inspector Frames panel (existing — no new code) |

## Pre-existing frames (orientation only)

The frames below are unchanged by this revision. See [packages/connector/src/tunnel/frames.ts](../packages/connector/src/tunnel/frames.ts) for current schemas:

- `register` — connector → controller, first frame after WS open
- `register-ack` — controller → connector, ack with `connectorId` (and optional error code on rejection)
- `manifest-delta` — bidirectional pattern in practice; connector → controller for tool changes
- `rpc` — opaque MCP JSON-RPC, both directions
- `heartbeat` — connector → controller every `policy.heartbeat_interval_ms`
- `goodbye` — connector → controller before SIGTERM-driven WS close
- `webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke` — webhook ingress (see [.claude/plans/STATUS-CALLBACK-MCP.md](../.claude/plans/STATUS-CALLBACK-MCP.md))

## Versioning

This document is v1. Future revisions:
- v1.1 / v1.2 — add fields to existing frames (additive, backwards-compatible).
- v2 — add new frame types (additive, controller MUST log+ignore unknown frames per §"Frame envelope").
- v3 — breaking change (rare). Would require a `protocol-capabilities` handshake at register time. **Not in scope today.**

When adding a frame, update this document FIRST, then implement.

## Cross-references

- [.claude/plans/MCP-LOADING.md](../.claude/plans/MCP-LOADING.md) — design intent, why these frames exist, workstream breakdown.
- [packages/connector/src/tunnel/frames.ts](../packages/connector/src/tunnel/frames.ts) — TypeScript type definitions for all frames.
- [packages/connector/src/tunnel/client.ts](../packages/connector/src/tunnel/client.ts) — connector-side WS client.
- [CLAUDE.md](../CLAUDE.md) — connector architecture, "Wire protocol — frames" section.
- [.claude/plans/STATUS-CALLBACK-MCP.md](../.claude/plans/STATUS-CALLBACK-MCP.md) — webhook frames spec.
