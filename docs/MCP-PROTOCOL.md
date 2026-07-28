# MCP-PROTOCOL — Connector ↔ Controller wire format

> **Audience.** This document is the contract between the customer-side **MCP connector** and the **controller**. It specifies every frame the connector sends or accepts on the `/mcp-tunnel` WSS, and the controller-side behaviour the connector relies on.
>
> **Authority.** This is the authoritative wire-format spec. If a frame is described here, it MUST be implemented per the schema below; if it is not described here, it MUST NOT be sent without first updating this doc.
>
> **Version.** v1.3 — additions covered by the most recent revisions:
> - **v1** baseline: `creds-request`, `creds-response`, `creds-update`.
> - **v1.1**: `mcp-config-snapshot`, `mcp-config-delta`, `mcp-config-ack`, `mcp-config-resync` for controller-driven 3rd-party MCP rosters; optional `mcpId` field on creds frames.
> - **v1.2**: two additive extensions —
>   - **MCP server-method extension** — widens the dispatcher to forward the full MCP server-method set (prompts / resources incl. templates + subscribe / completions / `logging/setLevel`); adds the `mcp-notification` frame for server→client notifications; manifest grows `prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities` on each `ServerDescriptor`. See §"v1.2 — MCP server-method extension".
>   - **Local MCPs rescan** — adds `local-mcps-rescan` (controller → connector) and `local-mcps-rescan-ack` (connector → controller) for operator-triggered drop-in folder rescans without a connector restart. See §"v1.2 — Local MCP rescan".
> - **v1.3** (this revision): **Customer drop-in approval gate** — adds `mcp-discovered` (connector → controller), `mcp-enable` (controller → connector), `mcp-disable` (controller → connector), `mcp-enable-ack` (connector → controller). Customer-authored drop-in MCPs no longer auto-enable when the connector finds the folder; their tools are withheld from the manifest until the controller sends `mcp-enable`. The controller becomes the gate for what surfaces to the LLM. See §"v1.3 — Customer drop-in approval gate".
>
> Pre-existing frames (`register`, `register-ack`, `manifest-delta`, `rpc`, `heartbeat`, `goodbye`, `webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke`) are documented in [connector/src/tunnel/frames.ts](../connector/src/tunnel/frames.ts) and [CLAUDE.md](../CLAUDE.md).

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

2. **Reply to every `creds-request` within ~1s.** Reply shape is always `creds-response` with a matching `requestId`. If the controller has no row for `(connectorId, mcp)`, reply with `{ env: {}, source: "none" }` — this is NOT an error, it's the documented "no row yet" reply. The connector treats it as "creds not available; child registers no tools." When a key is unavailable but others are, **omit the absent keys from `env` — never send empty strings.** See §"`creds-response` — controller MUST omit absent keys" for why (the connector's no-op-skip restart guard treats `""` differently from absent, which produces pointless restarts).

3. **Auto-fill `author: "twilio"` requests** from the per-org credentials it already holds — Twilio creds (typically the tunnel-security row) AND SendGrid creds (a sibling per-org store). See §"Twilio-bundled auto-fill" — the connector relies on this so customers never enter Twilio or SendGrid creds twice. The mapping is restricted to authentication credentials only; per-call operational values (phone numbers, service SIDs, sender emails) are tool arguments, not env.

4. **Push `creds-update` whenever creds change.** Operator-driven UI edits and tunnel-security rotation MUST both produce a `creds-update` frame. The connector restarts the child with the new env on receipt — that's the *only* way creds reach a running MCP child today, since bundled MCPs no longer read a local `.env`.

5. **Honour per-MCP scoping.** Every `creds-request` lookup MUST be scoped by the WS-authenticated `connectorId` AND the frame's `mcp` field — never `(connectorId, *)` or `(*, mcp)`. See §"Per-MCP scoping (CRITICAL — security-relevant)".

6. **Handle empty manifests cleanly.** A creds-gated MCP boots with zero tools when its required keys are absent (see §"Conditional tool registration"). Its `manifest.servers[]` entry will list `tools: []`. The controller's UI MUST surface this as "MCP exists but has no tools yet — supply credentials" rather than treating it as broken.

7. **Process `manifest-delta` frames as the source of truth for live tool changes.** When the connector restarts a child after a `creds-update`, the child's tool list may grow (creds arrived → tools register) or shrink (creds removed → tools unregister). The connector emits a `manifest-delta` frame on every such transition; the controller MUST update its tool index accordingly. This is the load-bearing signal for "creds → tool availability."

8. **Tolerate unknown frame types.** Log and ignore — never close the WS. This rule is symmetric with the connector's behaviour and is what allows additive evolution of the protocol.

9. **Audit operator actions.** Every UI edit that produces a `creds-update`, every `creds-request` received, and every WS-upgrade attempt SHOULD write to the controller's existing audit log (see §"Audit logging").

10. **Gate customer drop-in MCPs behind operator approval (v1.3+).** When the connector emits `mcp-discovered` for a customer-authored drop-in MCP, the controller MUST surface it in a "pending" UI lane and require an explicit operator gesture before sending `mcp-enable`. The connector withholds the MCP's tools from `manifest-delta` until enable arrives. After every `register-ack`, the controller MUST replay `mcp-enable` for every previously-approved drop-in (the connector keeps no approval state across restarts). See §"v1.3 — Customer drop-in approval gate".

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
| `SENDGRID_API_KEY` | per-org SendGrid creds (separate from tunnel-security row) | When the operator has configured a SendGrid key for this org |
| `TWILIO_OAUTH_CLIENT_ID` | row.oauthClientId | Posture: OAuth2 (FUTURE — flagged for revision) |
| `TWILIO_OAUTH_CLIENT_SECRET` | row.oauthClientSecret | Posture: OAuth2 (FUTURE — flagged for revision) |

**Rules:**
- Only keys *requested* via `envKeys` get filled. The controller does NOT shotgun every Twilio key.
- Missing keys (e.g. `TWILIO_AUTH_TOKEN` requested on an OAuth2-posture row, or `SENDGRID_API_KEY` when no SendGrid is configured) **MUST be omitted from `env` — NOT included as empty strings**. See §"`creds-response` — controller MUST omit absent keys" for the rationale (the connector's no-op-skip restart guard treats `{}` and `{X: ""}` as different payloads and would thrash the child).
- `source: "twilio-tunnel-row"` lets the inspector status panel show "from Twilio creds — synced when row rotates."
- Twilio-bundled MCPs consume `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (Twilio group, 16 tools), `SENDGRID_API_KEY` (SendGrid group, 4 tools), `SEGMENT_SPACE_ID` + `SEGMENT_PROFILE_PAT` (Segment-read group, 3 tools), and `SEGMENT_WRITE_KEY` (Segment-write group, 2 tools). Each group registers independently — see §"Conditional tool registration". The API-Key-posture row (which the controller still accepts at create time for tunnel-handshake verification) does NOT auto-fill any Twilio bundle env — customers on the API-Key posture must either also provide an AuthToken on the row for bundled MCPs to work, or run a sibling Auth-Token row for the connector.
- **Segment env keys are operator-entered, not auto-filled.** The four Segment env vars (`SEGMENT_SPACE_ID`, `SEGMENT_PROFILE_PAT`, `SEGMENT_WRITE_KEY`, plus the optional `SEGMENT_PROFILE_HOST` for EU residency) have no analogue in the tunnel-security row — Segment isn't part of the connector's identity. Treat them like `SENDGRID_API_KEY`: the controller stores them per-org in whichever credential surface holds operator-pasted bundled-MCP keys, and the response carries `source: "operator-entered"` (NOT `"twilio-tunnel-row"`).

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

**Server-level `envKeys` declaration.** A creds-gated MCP MUST declare its required keys at the server level (`createMcpHttpServer({ envKeys: [...] })`), not just per-tool. Why: when no tools are registered, per-tool aggregation is empty; the connector's `creds-request` would advertise zero envKeys; the controller would have nothing to fill in even when its tunnel-security row holds the right values. The server-level declaration is what tells the controller *what to populate* before any tool exists. The SDK aggregator at [connector/src/sdk/http-server.ts](../connector/src/sdk/http-server.ts) prefers server-level over per-tool when both are set.

**Gating granularity — per-service group, not per-tool or whole-bundle.** The Twilio bundle splits into two independent credential groups:

| Group | Required keys | Tools registered when group's keys are present |
|---|---|---|
| Twilio | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | messaging (4), voice (8), verify (3), lookups (1) — 16 total |
| SendGrid | `SENDGRID_API_KEY` | email (4) |

Each group registers independently. A customer running only Twilio (no SendGrid) sees the 16 Twilio tools and zero email tools — the 4 email tools simply aren't advertised. Vice versa for SendGrid-only. Within a group it's all-or-nothing — supplying `TWILIO_ACCOUNT_SID` without `TWILIO_AUTH_TOKEN` registers zero Twilio tools.

This is why the controller MUST omit absent keys from `creds-response.env` rather than sending empty strings — the bundle's per-group gating reads `!process.env[key]`, so `""` and absent are equivalent at the bundle level, BUT sending `""` causes the supervisor's `envEquals` no-op-restart guard to misclassify two identical "no SendGrid creds" payloads as different (`{}` vs `{SENDGRID_API_KEY: ""}`), thrashing the child. See §"creds-response — controller MUST omit absent keys."

## `creds-response` — controller MUST omit absent keys

When the controller has no value for an `envKeys`-requested key, the reply MUST omit that key from `env` — NOT include it as an empty string.

**Rule:**

```jsonc
// CORRECT — operator has only Twilio creds, no SendGrid
{ "type": "creds-response", "requestId": "...",
  "env": { "TWILIO_ACCOUNT_SID": "AC...", "TWILIO_AUTH_TOKEN": "..." },
  "source": "twilio-tunnel-row" }

// WRONG — same operator state, but key is sent as empty string
{ "type": "creds-response", "requestId": "...",
  "env": { "TWILIO_ACCOUNT_SID": "AC...", "TWILIO_AUTH_TOKEN": "...", "SENDGRID_API_KEY": "" },
  "source": "twilio-tunnel-row" }
```

**Why:**

- The connector's project-wide rule (see [connector/src/env.ts](../connector/src/env.ts)) treats empty string as "not set," so the gating check `!process.env[key]` returns true either way and the bundle behaves identically — zero tools register for the SendGrid group.
- BUT the connector's no-op-skip restart guard ([mcp-supervisor.ts](../connector/src/mcp-supervisor.ts) `envEquals`) compares the previously-applied `controllerEnv` to the new one by exact key set + value equality. `{}` and `{SENDGRID_API_KEY: ""}` are NOT equal — so two identical "no SendGrid creds" pushes (e.g. controller redelivering after a WS reconnect) thrash the child even though nothing changed.
- The empty-string shape is also visually confusing in the inspector and audit log: "controller says: empty value" reads differently from "controller has no value." Keep them distinct on the wire.

**Symmetric rule for `creds-update`:** same — omit, don't empty-string.

**Operator deletes the row entirely:** send `creds-update` with `env: {}` and `source: "none"`. The connector applies the empty merge, supervisor restarts, child registers zero tools (in whichever group the deleted row covered).

## No local `.env` — creds-over-the-wire (rolling out)

**Status: live on Type 2 controller-config MCPs as of 2026-06-30** (including the standalone `@deshartman/twilio-mcp` + `@deshartman/segment-mcp` packages that replaced the prior `mcp/bundled/twilio/` Type 1 bundle). Customer-authored drop-ins and Type 3 bundles still use the `dir/.env` fallback today; they will migrate to the same shape incrementally. The controller-side rules below apply per-MCP, not connector-wide.

Type 2 controller-config MCPs no longer rely on any on-disk `.env` for boot validation. All credentials reach the child *only* through the controller's `creds-response` / `creds-update` frames. Implications for controllers:

- **First-boot path is "creds-request → empty reply → empty manifest → operator fills row → creds-update → restart → full manifest."** A controller MUST NOT assume creds are pre-populated by the connector image; it MUST be prepared to push `creds-update` to a child whose tool list is currently `[]`.
- **An operator deleting a row MUST emit `creds-update` with `env: {}` and `source: "none"`.** That triggers the supervisor restart that empties the tool list — without the frame, the connector would keep using the stale env until next reconnect.
- **Customer-authored drop-ins and Type 3 bundles still honour `dir/.env`.** The connector's per-spec env precedence (process.env ⊕ dir/.env ⊕ yaml inline ⊕ controllerEnv) is unchanged. Controllers SHOULD treat `dir/.env` as transitional and aim to source every credential through `creds-update` over time.

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
// connector/src/sdk/tool.ts
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

When both shapes are set, **server-level wins** (it's the authoritative declaration). The SDK aggregator: [connector/src/sdk/http-server.ts](../connector/src/sdk/http-server.ts).

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
// logic registers ZERO tools (no Twilio group, no SendGrid group).
// manifest.servers reflects this:
//   { "name": "apis", "author": "twilio", "tools": [] }

// ─── operator fills only the Twilio half (no SendGrid yet) ───
// controller → connector — note SENDGRID_API_KEY is OMITTED, not "" empty
{
  "type": "creds-update",
  "mcp": "apis",
  "env": {
    "TWILIO_ACCOUNT_SID": "AC...",
    "TWILIO_AUTH_TOKEN": "auth_token_here"
  },
  "source": "twilio-tunnel-row",
  "reason": "Twilio creds entered by operator alice@example.com"
}

// connector restarts the apis child. Twilio group's keys are present —
// 16 Twilio tools register. SendGrid group's key is absent — 0 email
// tools register. manifest-delta:
{
  "type": "manifest-delta",
  "delta": {
    "added":   [/* 16 messaging/voice/verify/lookups tools */],
    "removed": [],
    "changed": []
  }
}

// ─── later, operator adds SendGrid ───
{
  "type": "creds-update",
  "mcp": "apis",
  "env": {
    "TWILIO_ACCOUNT_SID": "AC...",
    "TWILIO_AUTH_TOKEN": "auth_token_here",
    "SENDGRID_API_KEY": "SG..."
  },
  "source": "twilio-tunnel-row",
  "reason": "SendGrid key added by operator alice@example.com"
}

// 4 email tools register on top of the existing 16. delta:
{
  "type": "manifest-delta",
  "delta": {
    "added":   [/* 4 email_* tools */],
    "removed": [],
    "changed": []
  }
}
```

The reverse path (operator removes only the SendGrid key) sends `creds-update` with the Twilio keys still present and `SENDGRID_API_KEY` omitted; supervisor restarts; child registers 16 Twilio tools but zero email tools; connector emits a delta with the 4 email tools in `removed`.

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

The frames below are unchanged by this revision. See [connector/src/tunnel/frames.ts](../connector/src/tunnel/frames.ts) for current schemas:

- `register` — connector → controller, first frame after WS open
- `register-ack` — controller → connector, ack with `connectorId` (and optional error code on rejection)
- `manifest-delta` — bidirectional pattern in practice; connector → controller for tool changes
- `rpc` — opaque MCP JSON-RPC, both directions
- `heartbeat` — connector → controller every `policy.heartbeat_interval_ms`
- `goodbye` — connector → controller before SIGTERM-driven WS close
- `webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke` — webhook ingress (Twilio statusCallback / inbound-webhook delivery routed back over the tunnel)

## v1.1 — 3rd-party MCP roster (controller-driven)

> **Audience.** Controller team building the "New 3rd Party MCP" UI; connector team wiring it up.
>
> **Status.** Additive over v1. Existing v1 frames unchanged. Older controllers that don't implement v1.1 simply never push roster frames — connector keeps running its yaml-listed MCPs as today. Older connectors that don't implement v1.1 ignore the new frames per the §"Frame envelope" unknown-frame rule.

### Why

The connector's `connector.yaml` is the source of truth for **bundled** (Twilio-shipped) and **customer-authored** (Type 1 / Type 1 drop-in) MCPs. For **3rd-party MCPs** (everything else — public npm packages, customer-deployed HTTP endpoints, stdio binaries) the customer wants a UI experience: pick a transport, enter the URL or command, declare auth shape, save. The controller already has that UI surface; the connector should not duplicate it.

v1.1 adds frames the controller uses to push the **3rd-party MCP roster** down to the connector. The connector reconciles via the existing `mcp-supervisor.ts` and emits `creds-request` for each entry through the unchanged v1 path. The yaml is **not rewritten**. 3rd-party entries live in memory only; on every reconnect the controller re-pushes a snapshot.

### Identity — `mcpId` is the routing handle

Each 3rd-party MCP entry carries an `mcpId: string` minted by the **controller** when the operator clicks **Save** in the UI. This id is opaque to the connector — the connector never parses, generates, or validates it; it only echoes it back on `creds-request` frames and `mcp-config-ack` rows so the controller can correlate inbound traffic to a specific row.

**Why an id and not the name.** The controller is the source of truth — it CRUDs MCP rows, writes audit events, scopes creds lookups, and surfaces per-MCP status in its UI. `name` is human-editable (an operator can rename an MCP in the form), display-oriented (`name.toolName`), and routing-oriented on the connector side. None of those make `name` a stable database handle. The controller needs to be *explicit* about which row it is referring to — across rename, across `(name)` collisions if a future feature ever allowed them, and across audit log replay. `mcpId` gives every controller-initiated frame an unambiguous answer to "which row is this about?" without depending on `name` matching.

**Concrete consequences:**

- **Renames don't lose history.** Operator changes a row's name from `acme-search` to `acme-search-v2`. The controller pushes `mcp-config-delta { updated: [{mcpId: <same>, name: "acme-search-v2", ...}] }`. The connector sees the same `mcpId`, re-registers under the new name; the controller's row id (and audit history) survives unchanged. Without `mcpId`, the controller would have to track "old name → new name" out of band.
- **Creds scoping is unambiguous.** When the connector sends `creds-request { mcp: "acme-search", mcpId: "mcp_acme_01HK..." }`, the controller does `SELECT env FROM mcp_credentials WHERE connector_id = $auth AND mcp_id = $framePayload.mcpId` — no fuzzy matching. See §"`creds-request` / `creds-update` — additive `mcpId` field".
- **Ack rows map back 1:1.** Every entry in `mcp-config-ack.perMcp[]` carries `mcpId` so the controller's UI can update the exact row's status badge ("started 4s ago" / "failed: …") without having to find it by name.
- **Bundled / customer-authored MCPs DON'T get an `mcpId`.** They originate from yaml on the connector — the controller has no row to mint an id against. `creds-request` / `creds-update` for those MCPs omit the optional `mcpId` field; the controller falls back to `(connectorId, mcp)` scoping. See §"Per-MCP scoping (CRITICAL — security-relevant)" and §"`creds-request` / `creds-update` — additive `mcpId` field".

`name` remains the routing key for tool calls (`name.toolName`) and the display label. The pair `(connectorId, mcpId)` is globally unique on the controller; `(connectorId, name)` is unique on the connector but display-only on the wire.

**Format.** The connector treats `mcpId` as an opaque string. Pick whatever the controller already uses for stable ids — UUID v4, ULID, a prefixed nanoid (e.g. `mcp_<26-char>`), or the row's database primary key — and keep it consistent. Length, character set, and human-readability are all controller-side decisions.

### Boot timing

1. `register` → `register-ack` (v1 unchanged).
2. **Controller sends ONE `mcp-config-snapshot`** with the full current 3rd-party MCP roster for this connector. Empty `servers: []` is valid — it means "this connector has no 3rd-party MCPs configured."
3. Connector reconciles each entry through the supervisor; emits `mcp-config-ack` with per-MCP status.
4. Connector sends `creds-request` per 3rd-party MCP whose `envKeys.length > 0`. Same v1 path; the request carries `mcpId` in addition to `mcp`.
5. Controller replies `creds-response` per entry; connector merges env via supervisor.

### Steady-state push (delta semantics)

After the boot snapshot, every operator CRUD action in the controller UI emits ONE delta frame:

| Operator action | Frame | Connector reaction |
|---|---|---|
| Save new MCP | `mcp-config-delta { added: [entry] }` | `supervisor.startEntry(spec)` |
| Edit existing MCP | `mcp-config-delta { updated: [entry] }` | `supervisor.restart(name, "config-update")` with new spec |
| Delete MCP | `mcp-config-delta { removed: [mcpId] }` | `supervisor.stopEntry(name)` |

Every delta carries a monotonically-increasing `generation: number`. The connector tracks `lastAppliedGeneration` and:

- If `delta.generation === lastAppliedGeneration + 1` — apply.
- If `delta.generation > lastAppliedGeneration + 1` — gap; send `mcp-config-resync { reason: "gap" }`. Controller MUST reply with a fresh `mcp-config-snapshot` at the latest generation.
- If `delta.generation <= lastAppliedGeneration` — duplicate / out-of-order; log + drop.

Snapshots also carry `generation`. A snapshot supersedes any pending state and resets `lastAppliedGeneration`.

### Frames

#### `mcp-config-snapshot` (controller → connector)

```ts
interface McpConfigSnapshotFrame {
  type: "mcp-config-snapshot";
  generation: number;            // monotonic per-connector across snapshots AND deltas
  servers: McpConfigEntry[];     // FULL roster of 3rd-party MCPs (may be empty)
}
```

Sent on `register-ack` (always — even if empty), and as the reply to a connector-initiated `mcp-config-resync`.

#### `mcp-config-delta` (controller → connector)

```ts
interface McpConfigDeltaFrame {
  type: "mcp-config-delta";
  generation: number;
  added?:    McpConfigEntry[];
  updated?:  McpConfigEntry[];   // full new spec replaces prior by mcpId
  removed?:  string[];           // mcpIds to remove
}
```

Sent during steady state on every operator CRUD action. The arrays are exclusive — a single frame typically carries exactly one of `added` / `updated` / `removed` populated, but the connector MUST handle multiple in one frame (controller may batch).

#### `mcp-config-ack` (connector → controller)

```ts
interface McpConfigAckFrame {
  type: "mcp-config-ack";
  generation: number;            // generation that was applied
  perMcp: Array<{
    mcpId: string;
    name: string;
    status: "started" | "failed" | "skipped" | "removed";
    error?: string;              // human-readable, surfaced in the controller row
  }>;
}
```

Sent after applying a snapshot or delta. `status: "skipped"` is reserved for entries the connector cannot run today — for example, an entry missing a required field (`http` without `url`, `stdio` without `command`) or, on a future connector version, an unrecognised transport. The controller surfaces this in the row's status badge. As of 2026-06-21 (v1.1) all five wire transports — `stdio` / `http` / `streamable-http` / `sse` / `websocket` — are supported by the connector; field-validation skips remain.

**`status: "removed"` arrives after the row is already gone.** The controller deletes its row before sending `mcp-config-delta { removed: [mcpId] }`, so by the time the matching `removed` ack lands the row is no longer in the DB. The handler MUST tolerate the row being absent — log + drop, don't upsert. A naive "always upsert by mcpId" handler would FK-error here.

#### `mcp-config-resync` (connector → controller)

```ts
interface McpConfigResyncFrame {
  type: "mcp-config-resync";
  reason: "gap" | "boot" | "manual";
}
```

Sent when the connector detects a generation gap (`reason: "gap"`), at boot if no snapshot has arrived after a soft-wait (`reason: "boot"` — sent at the 5s mark, alongside the existing creds-request soft-wait), or on operator action (`reason: "manual"` — triggered from the inspector "Resync MCPs" button, future work). Controller MUST reply with `mcp-config-snapshot`.

### `McpConfigEntry` schema

```ts
interface McpConfigEntry {
  mcpId: string;                 // controller-minted; stable across this MCP's lifetime
  name: string;                  // routing key + display label; unique per connector
  description?: string;
  transport: "http" | "streamable-http" | "sse" | "websocket" | "stdio";
  // Transport-specific:
  url?: string;                  // http | streamable-http | sse | websocket
  command?: string[];            // stdio (e.g. ["npx", "--yes", "aviation-weather-mcp"])
  // Auth shape — VALUES never appear here; only the env-key NAMES the connector
  // should attach values to. Values arrive via creds-response per the v1 path.
  auth: McpAuthSpec;
  // Names of env vars the upstream MCP needs at the wire boundary (forwarded
  // to creds-request.envKeys). Independent of auth.envKey, which is also
  // automatically merged in by the connector.
  envKeys?: string[];
}

type McpAuthSpec =
  | { kind: "none" }
  | { kind: "bearer"; envKey: string }
      // Connector attaches `Authorization: Bearer ${env[envKey]}` on outbound MCP calls.
  | { kind: "header"; headerName: string; envKey: string }
      // Connector attaches `${headerName}: ${env[envKey]}` on outbound MCP calls.
  | { kind: "oauth2-client-credentials";
      tokenUrlEnvKey: string;
      clientIdEnvKey: string;
      clientSecretEnvKey: string;
      scopes?: string[] };
      // Connector mints + caches a JWT via client_credentials grant against
      // env[tokenUrlEnvKey] and attaches `Authorization: Bearer <jwt>`.
      // Reuses connector/src/auth/oauth-provider.ts.
```

**Auth shape is on the wire; values are not.** The controller stores creds in its existing per-org credential surface. When the connector asks for them via `creds-request` (v1), the response fills the env keys this entry declared. The same `creds-update` push path applies to rotations.

### Transport ↔ connector spec mapping

| Frame `transport` | Connector internal spec |
|---|---|
| `stdio` + `command` | Type 2 stdio (`transport: "stdio"`, `command: [...]`) — same as today's `aviation-weather` |
| `http` + `url` | Type 2 http (`transport: "http"`, `endpoint: <url>`, `headers: {...}` synthesized from auth) |
| `streamable-http` + `url` | Same as `http` (the SDK transport choice; connector treats them identically on the spec layer) |
| `sse` + `url` | Type 2 sse — supervisor `transport: "http"` spec with internal `__transportKind: "sse"` marker; routed to `connectSse` in [`servers/connect.ts`](../connector/src/servers/connect.ts). Auth headers flow through `requestInit.headers` on the recurring POST requests. |
| `websocket` + `url` | Type 2 websocket — supervisor `transport: "http"` spec with internal `__transportKind: "websocket"` marker; routed to `connectWebSocket`. Separate from the connector ↔ controller `/mcp-tunnel` WS. **Auth must be embedded in the URL** (token query param, basic-auth in URL userinfo, etc.) — the SDK's WebSocket transport accepts no headers; resolved auth headers are dropped with a warn. |

> **WebSocket clarification (CRITICAL).** A `transport: "websocket"` 3rd-party MCP means the **connector dials a separate WS** out to the upstream MCP server's URL to talk JSON-RPC. This is **completely independent** from the connector ↔ controller `/mcp-tunnel` WS that this entire protocol rides on. They share no auth, no socket, no lifecycle.

### Auth attachment — connector side

For HTTP-family transports, the connector resolves the `auth` shape into outbound HTTP headers at connect time:

- `kind: "bearer"` → `Authorization: Bearer ${env[envKey]}`
- `kind: "header"` → `${headerName}: ${env[envKey]}`
- `kind: "oauth2-client-credentials"` → connector mints a JWT via the `client_credentials` grant against `env[tokenUrlEnvKey]`, caches with <60s pre-expiry refresh (reuses [connector/src/auth/oauth-provider.ts](../connector/src/auth/oauth-provider.ts)), attaches `Authorization: Bearer <jwt>`.

For stdio, the connector passes the env vars to the subprocess (existing path); auth is the upstream subprocess's responsibility (e.g. aviation-weather-mcp reads its own API keys from env).

### Yaml ⊕ controller-roster — disjoint sets

There is no name-conflict resolution. The yaml lists bundled + customer-authored MCPs only; controller-supplied 3rd-party MCPs live in a separate in-memory roster keyed by `mcpId`. The yaml does NOT carry `mcpId`; controller-supplied entries do NOT appear in the yaml. If a customer puts a 3rd-party MCP in their yaml *and* configures one in the controller UI with the same `name`, the connector treats them as two separate entries: the yaml entry registers first at boot; the controller entry's `addEntry` path sees `supervisor.hasEntry(name) → true` AND its own `nameToMcpId.get(name) → undefined`, distinguishes the clash mode (yaml vs roster-internal — see below), and acks the controller entry as `status: "failed"` with one of:

- `error: "name conflict with yaml entry \"<name>\""` — when the existing supervisor entry was registered by the boot path (yaml).
- `error: "name conflict with another controller-config entry (mcpId=<otherMcpId>)"` — when the existing supervisor entry came from a prior controller-config delta in this same roster (this is a defensive-only branch — the controller UI should prevent operators from creating two rows with the same name; reach this branch via duplicate delta delivery on reconnect or controller-side bug, not via the happy path).

Either branch leaves the existing entry untouched and skips spawning the new one.

### Persistence — none on disk; memory across WS reconnects

The 3rd-party roster is **NOT** persisted on the connector to disk. It IS held in memory for the lifetime of the connector process — `McpConfigCoordinator` is constructed once per process (alongside the supervisor it tracks), and per-tunnel rebind (`bind({send})`) only swaps the wire callback. Roster + `lastAppliedGeneration` survive WS reconnect by design; they are reset only on full process restart.

On WS reconnect (steady-state — process did not restart):

1. `register` → `register-ack`.
2. Controller pushes `mcp-config-snapshot` at the current generation.
3. Connector reconciles the in-memory roster against the snapshot:
   - Entries in snapshot but not in roster → `supervisor.registerOne` + `startOne`.
   - Entries in roster but not in snapshot → `supervisor.unregister` (kills child + drops connection).
   - Entries in both with changed spec → `supervisor.replaceSpec` (restart).
   - Entries in both with same spec → no-op.

On full process restart, `lastAppliedGeneration` resets to `-1` and the next snapshot at any generation re-establishes the roster from scratch — the controller is the brain, the connector is the executor, and the snapshot is always authoritative.

**Why memory-but-not-disk:** the roster needs to be diff'd against incoming snapshots so the "Removed" loop catches entries the operator deleted while the WS was down. A per-tunnel coordinator with empty memory would skip that loop and leak supervisor entries across reconnect (manifested 2026-06-21 as a false "name conflict with yaml entry \"X\"" on re-add of a deleted row). On-disk persistence is the wrong layer — it would require migration on schema change and could go stale relative to controller state during a connector outage. Memory + "snapshot is always authoritative on reconnect" gives the right trade.

### Audit logging

Every operator action in the controller UI MUST write an audit row before sending the resulting frame. Connector-side: every `mcp-config-snapshot` / `mcp-config-delta` applied logs `mcp_config_applied generation=N added=[...] updated=[...] removed=[...]` at info level. Same shape as the existing `creds_version_changed` line.

### Backwards compat

| Side | Older counterpart | Behavior |
|---|---|---|
| Controller v1.1, connector v1 | Connector ignores `mcp-config-*` frames per the unknown-frame rule. Controller sees no `mcp-config-ack`. Controller SHOULD surface this in the connector row as "connector version too old for 3rd-party MCPs." |
| Controller v1, connector v1.1 | Connector sends `mcp-config-resync { reason: "boot" }` after 5s soft-wait. v1 controller ignores it. Connector continues with empty 3rd-party roster; logs `warn`. WS stays open. |

Same `5s soft-wait + log warn` shape as the `creds-request` backwards-compat path. Symmetric and predictable.

### `creds-request` / `creds-update` — additive `mcpId` field

Existing v1 creds frames gain an optional `mcpId?: string` field for entries originating from `mcp-config-snapshot` / `mcp-config-delta`. Bundled and customer-authored MCPs (yaml-listed) omit it.

```ts
// Connector → controller. Now carries optional mcpId for controller-config-sourced MCPs.
interface CredsRequestFrame {
  type: "creds-request";
  requestId: string;
  mcp: string;
  mcpId?: string;       // NEW v1.1 — set when source is controller config
  author: "twilio" | "customer";
  envKeys: string[];
}

// Controller → connector. Unchanged shape; optional mcpId for symmetric routing.
interface CredsUpdateFrame {
  type: "creds-update";
  mcp: string;
  mcpId?: string;       // NEW v1.1
  env: Record<string, string>;
  source: CredsSource;
  reason?: string;
}
```

Controller MUST scope creds lookups by `(connectorId, mcpId)` when `mcpId` is present, falling back to `(connectorId, mcp)` for v1 (yaml-listed) entries. NEVER scope by `mcp` alone — that's the cross-connector creds-leak path.

### Examples

#### Boot — empty roster

```jsonc
// connector → controller (v1, unchanged)
{ "type": "register", "name": "prod-east", ... }

// controller → connector (v1, unchanged)
{ "type": "register-ack", "connectorId": "conn_abc123" }

// controller → connector (v1.1)
{ "type": "mcp-config-snapshot", "generation": 7, "servers": [] }

// connector → controller (v1.1)
{
  "type": "mcp-config-ack",
  "generation": 7,
  "perMcp": []
}
```

#### Boot — one stdio MCP (aviation-weather, no auth)

```jsonc
// controller → connector
{
  "type": "mcp-config-snapshot",
  "generation": 12,
  "servers": [
    {
      "mcpId": "mcp_aw_01HK...",
      "name": "aviation-weather",
      "description": "FAA / NOAA aviation weather data",
      "transport": "stdio",
      "command": ["npx", "--yes", "aviation-weather-mcp"],
      "auth": { "kind": "none" },
      "envKeys": []
    }
  ]
}

// connector → controller (creds-request still fires for v1 symmetry, even though envKeys is empty)
{
  "type": "creds-request",
  "requestId": "11111111-...",
  "mcp": "aviation-weather",
  "mcpId": "mcp_aw_01HK...",
  "author": "customer",
  "envKeys": []
}

// controller → connector
{
  "type": "creds-response",
  "requestId": "11111111-...",
  "env": {},
  "source": "none"
}

// connector spawns child via supervisor; tools register; manifest-delta to controller; ack:
{
  "type": "mcp-config-ack",
  "generation": 12,
  "perMcp": [
    { "mcpId": "mcp_aw_01HK...", "name": "aviation-weather", "status": "started" }
  ]
}
```

#### Boot — one HTTP MCP with Bearer auth

```jsonc
// controller → connector
{
  "type": "mcp-config-snapshot",
  "generation": 13,
  "servers": [
    {
      "mcpId": "mcp_acme_01HK...",
      "name": "acme-search",
      "transport": "http",
      "url": "https://api.acme.example.com/mcp",
      "auth": { "kind": "bearer", "envKey": "ACME_BEARER" },
      "envKeys": ["ACME_REGION"]
    }
  ]
}

// connector → controller — envKeys union of auth.envKey + entry.envKeys
{
  "type": "creds-request",
  "requestId": "22222222-...",
  "mcp": "acme-search",
  "mcpId": "mcp_acme_01HK...",
  "author": "customer",
  "envKeys": ["ACME_BEARER", "ACME_REGION"]
}

// controller → connector
{
  "type": "creds-response",
  "requestId": "22222222-...",
  "env": { "ACME_BEARER": "tk_live_...", "ACME_REGION": "us-east" },
  "source": "operator-entered"
}

// connector connects the HTTP MCP with header `Authorization: Bearer tk_live_...`
// (and forwards ACME_REGION as a connector-side env var available to the HTTP transport
// if/when a future change wires per-server env into outbound calls).

// ack:
{
  "type": "mcp-config-ack",
  "generation": 13,
  "perMcp": [
    { "mcpId": "mcp_acme_01HK...", "name": "acme-search", "status": "started" }
  ]
}
```

#### Steady state — operator deletes the MCP

```jsonc
// controller → connector
{
  "type": "mcp-config-delta",
  "generation": 14,
  "removed": ["mcp_acme_01HK..."]
}

// connector stops the child; manifest-delta removes its tools; ack:
{
  "type": "mcp-config-ack",
  "generation": 14,
  "perMcp": [
    { "mcpId": "mcp_acme_01HK...", "name": "acme-search", "status": "removed" }
  ]
}
```

#### Generation gap — connector requests resync

```jsonc
// connector last applied generation 12, then receives:
{ "type": "mcp-config-delta", "generation": 15, "added": [...] }

// connector detects gap (15 > 12 + 1):
{ "type": "mcp-config-resync", "reason": "gap" }

// controller replies with current snapshot:
{ "type": "mcp-config-snapshot", "generation": 15, "servers": [...] }

// connector reconciles to snapshot; emits ack with generation=15.
```

## Implementation notes for the controller team

The connector treats the wire format above as ground truth. A few choices it leaves open to the controller — calling them out so the controller-side implementation is predictable.

### `mcpId` format

Opaque to the connector. Pick whatever the controller already uses for stable database ids — UUID v4, ULID, prefixed nanoid (`mcp_<26-char>`), or the row's PK. Length, character set, human-readability are all controller-side decisions. Required: stable across the row's lifetime (do NOT re-mint on rename); unique within `(connectorId, mcpId)`.

### `generation` format and persistence

Monotonic per-connector across snapshots and deltas. The connector treats lower-than-last-applied generations as superseded and drops them. **The controller MUST persist this counter** — if it resets on controller restart, the connector will silently drop everything until a generation > the prior persisted value arrives. A Postgres `bigserial` column on the connector row is the simplest correct shape.

### `name` uniqueness — controller-side enforcement

The connector enforces "one entry per name" via the supervisor's primary key. A second entry with the same name silently does not spawn — the connector reports it via `mcp-config-ack` as `status: "failed", error: "..."`, but the user-visible failure mode is "I added an MCP and it isn't working."

The controller UI SHOULD enforce uniqueness within the controller's own roster for a given connector at save time so this never reaches the wire. Yaml-side collisions (a 3rd-party MCP entered in the controller UI with the same name as a bundled or customer-authored MCP in `connector.yaml`) cannot be detected controller-side — they show up only via the ack frame. Surface the `error` string from the ack verbatim in the controller UI's row status so the operator can correct the right side.

### `envKey` naming — operator-entered vs auto-mint

The connector reads `controllerEnv[auth.envKey]` to resolve `auth.kind: "bearer"` and `auth.kind: "header"`, and reads the three OAuth2 envKeys for the JWT mint flow. For `kind: "header"`, the `headerName` is upstream's choice; the `envKey` is internal. For stdio MCPs, the env var is read by the upstream subprocess so the name MUST match the subprocess's expectation.

A practical rule for the controller UI:

| Auth shape | envKey naming on the form |
|---|---|
| stdio (any auth) | operator-entered (mandatory) — child reads env directly |
| HTTP-family + `bearer` | auto-mint OK (e.g. `${NAME_UPPER}_BEARER`) — invisible to upstream |
| HTTP-family + `header` | operator-entered (paired with `headerName`) — UX coherence with the header field |
| HTTP-family + `oauth2-client-credentials` | auto-mint OK for all three — invisible to upstream |
| `envKeys[]` extras row | operator-entered — these ARE the upstream's required env vars |

**Collision warning.** If the auto-minted name AND an operator-entered `envKeys[]` extra collide on the same MCP, the connector receives one value for both. Validate at save time.

### `mcp-config-snapshot` is required at register-ack — even when empty

The connector's boot soft-wait expects a snapshot to arrive within ~5s of register-ack. If the controller has zero 3rd-party MCPs for this connector, send `{ generation: <persisted>, servers: [] }` rather than withholding the frame — the connector logs a `boot` resync request after the soft-wait elapses, which is noise the operator doesn't need to see.

## v1.2 — Local MCP rescan (controller-triggered)

The customer-authored "local" MCP shape is folders under `${MCP_DROPIN_DIR}/<name>/{tools,prompts,resources}/*.ts` discovered by the connector at boot (see [src/dropin.ts](../connector/src/dropin.ts) and the authoring walkthrough at [docs/AUTHOR-LOCAL-MCP.md](AUTHOR-LOCAL-MCP.md)). Without an explicit refresh frame, dropping a new folder into a running connector requires a process restart for the controller to see it. v1.2 closes that gap with a single round-trip on the existing tunnel.

Two frames, both opaque to the customer:

### `local-mcps-rescan` (controller → connector)

```json
{ "type": "local-mcps-rescan" }
```

No payload. The connector decides what's there; the controller just triggers. Sent when the operator clicks **Refresh local MCPs** in the controller UI (Connector detail → MCPs tab). The connector re-runs `discoverDropins({yamlNames})` against `MCP_DROPIN_DIR`, diffs against the running supervisor entries, then:

- For added entries: `supervisor.registerOne(spec, { source: "local" }) → startOne(name)` and fan out a `creds-request` for that MCP.
- For removed entries: `supervisor.unregister(name)`.
- For changed entries (e.g. `dir/.env` edited or tools added): `supervisor.replaceSpec(name, newSpec)`.

Manifest changes ride the existing `manifest-delta` path. The dedicated `local-mcps-rescan-ack` carries only the diff summary so the controller's UI can show "Done — N added, M removed."

### `local-mcps-rescan-ack` (connector → controller)

```json
{
  "type": "local-mcps-rescan-ack",
  "added": [{ "name": "orders", "toolsCount": 3 }],
  "removed": ["legacy-billing"],
  "unchanged": ["sample", "crm"],
  "errors": []
}
```

| Field | Type | Notes |
|---|---|---|
| `added` | `{name, toolsCount}[]` | New folders accepted. `toolsCount` is the post-spawn `tools/list` size. |
| `removed` | `string[]` | Folders no longer present. Names — drop-ins don't have `mcpId`. |
| `unchanged` | `string[]` | Folders that scanned identically to the prior pass. |
| `errors` | `{name, error}[]` | Folders the connector tried to add but couldn't (spawn failed, port exhausted, etc). Per-folder isolation: one bad drop-in does not abort the rescan. |

The ack is fire-and-forget — there's no second round-trip from the controller. If the WS drops mid-rescan, the controller's UI shows a stale state until the next register-ack triggers a fresh manifest push.

**Inspector parity.** The connector also exposes the same operation via a loopback-only POST at `/mcp/rescan-local` on the inspector port — for local-dev iteration that doesn't need the controller round-trip. Same coordinator method on both paths.

**No fs-watcher.** Operator-driven only. An auto-watcher on `${MCP_DROPIN_DIR}` was deliberately rejected — fs events fire mid-edit (a save-in-progress would spawn a child against half-written code), the connector has no way to distinguish operator intent ("I'm done editing") from intermediate save events, and a debounce window would just push the race. Explicit operator action is the right primitive.

**Backwards compat.** A v1.1 controller never sends this frame, so the connector's behaviour is unchanged. A v1.1 connector ignores the frame per the unknown-frame rule and the controller's UI surfaces "rescan unsupported by this connector version."

## v1.2 — MCP server-method extension (prompts / resources / completions / logging)

### Why

The v1.0/v1.1 connector dispatched `tools/list` + `tools/call` and rejected every other MCP method with `-32601 method not found`. v1.2 widens the dispatcher to forward the rest of the server-method surface — **prompts**, **resources** (incl. templates + subscribe), **completions**, **logging/setLevel** — and adds a server→client notification path so MCPs can emit `notifications/progress`, `notifications/message`, `notifications/resources/updated`, and the `*/list_changed` notifications back to the controller. Both pieces are additive over v1.1; older controllers see no change.

### Manifest extension

`ServerDescriptor` (in `register` and snapshot manifests) grows three optional arrays plus a `capabilities` object. Older controllers ignore them per §"Frame envelope" unknown-fields rule.

```ts
interface ServerDescriptor {
  // v1.0/v1.1 fields:
  name: string;
  transport: "http" | "stdio";
  author: string;
  tools: ToolDescriptor[];

  // v1.2 additive — present only when the upstream MCP advertised the
  // matching capability. Empty array vs absent: the connector emits the
  // array only when at least one item exists, so absence and "advertised
  // but empty" both render as "off / none" in the controller UI.
  prompts?: PromptDescriptor[];
  resources?: ResourceDescriptor[];
  resourceTemplates?: ResourceTemplateDescriptor[];
  capabilities?: {
    prompts?:    { listChanged?: boolean };
    resources?:  { listChanged?: boolean; subscribe?: boolean };
    tools?:      { listChanged?: boolean };
    completions?: {};
    logging?:    {};
  };
}

interface PromptDescriptor {
  name: string;                  // server-relative; wire form is "${server}.${name}"
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

interface ResourceDescriptor {
  uri: string;                   // e.g. "ek://sources/abc"
  name: string;
  description?: string;
  mimeType?: string;
}

interface ResourceTemplateDescriptor {
  uriTemplate: string;           // RFC 6570
  name: string;
  description?: string;
  mimeType?: string;
}
```

`ManifestDelta` grows symmetrically with `addedPrompts` / `removedPrompts` / `changedPrompts`, the same triple for `Resources`, and the same triple for `ResourceTemplates`. Each is optional + omitted-when-empty so older controllers see today's tools-only delta untouched.

### Server-method passthrough — request methods

Every method below is forwarded to the upstream MCP through the `McpServerConnection` matching method. The connector does NOT interpret payloads — pass-through is verbatim. **Server discriminator:** prompts use `${server}.${name}` like tools; resources use the URI scheme/host; aggregate methods accept an optional `params.serverName` that narrows to one MCP (omit to fan out).

| MCP method | Routing key | Payload shape (forwarded verbatim) |
|---|---|---|
| `prompts/list` | `params.serverName` (optional, narrows to one MCP) | `{}` |
| `prompts/get` | `params.name = "${server}.${prompt}"` | `{ name, arguments? }` |
| `resources/list` | `params.serverName` (optional) | `{}` |
| `resources/templates/list` | `params.serverName` (optional) | `{}` |
| `resources/read` | `params.serverName` OR fallback to URI scheme | `{ uri }` |
| `resources/subscribe` | `params.serverName` OR URI scheme | `{ uri }` |
| `resources/unsubscribe` | `params.serverName` OR URI scheme | `{ uri }` |
| `completion/complete` | `params.serverName` REQUIRED | full `complete` request body |
| `logging/setLevel` | `params.serverName` REQUIRED | `{ level }` |

**Errors** the connector emits before forwarding:
- `-32602 INVALID_PARAMS` — missing required field (e.g. `prompts/get` with no `${server}.${name}` form, `resources/read` with empty `uri`, `completion/complete` without `params.serverName`).
- `-32010 (kind: "server_not_found")` — explicit `serverName` doesn't resolve, or no URI-scheme match.
- `-32601 METHOD_NOT_FOUND` — unrecognized method (kept for forward-compat).

Upstream errors flow back unchanged.

### `mcp-notification` frame (connector → controller)

Server-initiated notifications emitted by an MCP get wrapped and forwarded as a single new frame. **Connector is a pure forwarder — payload is opaque.** Same async-free `send()` path as the existing `webhook` frame so a notification burst doesn't starve heartbeats.

```ts
interface McpNotificationFrame {
  type: "mcp-notification";
  server: string;             // matches ServerDescriptor.name
  payload: unknown;           // JSON-RPC notification envelope: { method, params? }
}
```

Examples the controller will receive:
- `{ method: "notifications/progress", params: { progressToken, progress, total? } }` — correlate by `progressToken` to the original request.
- `{ method: "notifications/message", params: { level, logger, data } }` — this is `logging/message` on the wire.
- `{ method: "notifications/resources/updated", params: { uri } }` — only after `resources/subscribe` succeeded.
- `{ method: "notifications/{tools,prompts,resources}/list_changed" }` — re-fetch the list.

**Loss model.** Notifications fired between WS close and reopen are dropped — they're advisory by spec, and the controller will re-list-resources / re-subscribe / re-fetch progress on its next call. The connector does NOT queue them across reconnects (queueing risks unbounded memory on a long outage; stale events are worse than missing ones).

### `progressToken` round-trip

A controller request can opt into progress reporting by setting `params._meta.progressToken`. The connector forwards verbatim; the upstream MCP emits `notifications/progress` with the same token; the connector wraps as `mcp-notification`. **No new connector logic** — it's all passthrough as long as the new method routing is open.

### Server-side capability advertisement

The connector itself stays a passthrough — it does NOT declare `sampling`, `elicitation`, or `roots` capabilities to upstream MCPs. The connector core is LLM-free (CLAUDE.md "No LLM, no agent loop, no document handling — *in the connector core*"); a future controller may implement those server→client request types via a separate frame, but they are NOT shipped in v1.2.

### Backwards compat

- **Older controller, new connector.** Connector advertises `prompts[]` / `resources[]` in the manifest; older controller sees only the `tools[]` field it always read. Connector emits `mcp-notification` frames; older controller logs+drops per the unknown-frames rule. Tools-only flow keeps working.
- **Newer controller, older connector.** Controller calls `prompts/list` over the tunnel; older connector's dispatcher returns `-32601 method not found`. Controller treats that exactly like a server that didn't declare the prompts capability.

## v1.3 — Customer drop-in approval gate

> **Status: shipped.** Older controllers that don't speak v1.3 keep working — they don't see `mcp-discovered`, so customer drop-ins stay pending forever (fail-closed). See §"v1.3 — Backwards compat" below.

### Why

Through v1.2, customer-authored drop-in MCPs auto-enable the moment the connector sees the folder under `${MCP_DROPIN_DIR}`. The customer admin's gate is the filesystem (whoever has write access). The controller is informed via `manifest-delta`, but has no acceptance gesture between "connector spawned the child" and "LLM can call the tool."

This asymmetric with 3rd-party (Type 2) MCPs, which require the operator to author them in the controller UI before they appear, AND with bundled (Type 3 + yaml-listed Type 1) MCPs, which require Twilio engineering to ship them in the connector image. Customer drop-ins were the only path with no operator-side acceptance.

v1.3 closes that gap. The controller becomes the **acceptance authority** for customer drop-ins:

- Connector spawns the child (unchanged — same crash isolation).
- Connector advertises the MCP via `mcp-discovered` (NEW).
- Operator approves in controller UI; controller sends `mcp-enable` with optional creds (NEW).
- Connector adds tools to manifest, emits `manifest-delta`.
- LLM can call the tool.

Approval state lives **controller-only**. After every `register-ack`, the controller replays `mcp-enable` for every previously-approved drop-in. The connector keeps no approval persistence across restarts — same posture as the 3rd-party MCP roster.

### What gates and what doesn't

| MCP type | Source field | Gated in v1.3? |
|---|---|---|
| Customer drop-in | `source: "local"` (`__dropin: true` marker) | **YES** — requires `mcp-enable` |
| Yaml-listed Type 1 hand-written | `source: "yaml"` | NO — yaml IS the acceptance |
| Bundled Type 3 (Twilio Python venvs) | `source: "yaml"` (with `bundled:` resolver) | NO — Twilio ships in image |
| 3rd-party Type 2 (controller-pushed) | `source: "controller-config"` | NO — already operator-authored |

The gate predicate on the connector side is exactly `author === "customer"` AND `source === "local"`. Anything else flows through unchanged.

### `mcp-discovered` (connector → controller)

```ts
interface McpDiscoveredFrame {
  type: "mcp-discovered";
  mcp: string;                    // folder name; stable identity across reconnects
  author: "customer";             // always — bundled / yaml / 3rd-party MCPs don't go through this gate
  source: "local";                // always — co-occurs with author:"customer" but kept distinct for clarity
  envKeys: string[];              // de-duped union from the child's /envkeys endpoint
  tools: Array<{
    name: string;                 // e.g. "issue_refund"
    description?: string;         // from the tool's register() metadata; absent if author omitted
  }>;
  discoveredAt: string;           // ISO8601, connector wall-clock
}
```

Sent at two emission points:

1. **Boot.** After `register` is sent (so the controller has a `connectorId` to scope against), one frame per drop-in MCP discovered on disk. The connector emits this for ALL drop-ins, including ones the controller may have approved previously — the connector has no persistent approval state, and trusts the controller to reply `mcp-enable` for the ones it has on file.
2. **Runtime rescan.** When [`LocalMcpsCoordinator.rescan()`](../connector/src/tunnel/local-mcps-coordinator.ts) discovers a new drop-in folder and spawns its child, one frame per added MCP.

**Deliberately NOT in the payload:**
- `inputSchema` / `outputSchema` — the actual call surface; withheld until approval.
- `prompts` / `resources` — for now only `tools` is gated; v1.4 may extend.
- `mcpId` — the controller mints its own row id on first approval; the connector identifies by `(connectorId, mcp)` end-to-end (folder name is the wire identity).

**Example:**

```json
{
  "type": "mcp-discovered",
  "mcp": "crm",
  "author": "customer",
  "source": "local",
  "envKeys": ["MOCK_CUSTOMERS_URL"],
  "tools": [
    { "name": "get_customer",  "description": "Returns the customer's identity profile keyed by phone." },
    { "name": "get_recent",    "description": "Returns the customer's most recent order." },
    { "name": "issue_refund",  "description": "Issues a refund for a given order_id." }
  ],
  "discoveredAt": "2026-06-23T12:00:00Z"
}
```

### `mcp-enable` (controller → connector)

```ts
interface McpEnableFrame {
  type: "mcp-enable";
  mcp: string;
  env?: Record<string, string>;   // optional — pasted creds; subset of envKeys is fine
  source?: "operator-entered";    // for telemetry / inspector display; reserved for future values
}
```

Sent at two emission points:

1. **Operator approval.** New approval click in the controller UI. Operator may paste env values inline; if so, `env` is populated.
2. **Replay on register-ack.** For every previously-approved MCP, the controller MUST re-send `mcp-enable` after `register-ack`. This is the source-of-truth-restore mechanism — the connector's in-memory approved-set survives WS reconnects but does NOT survive process restarts, so the controller is the durable authority.

The connector treats both forms identically:
- `env` present → `supervisor.applyControllerEnv(name, env, source, "mcp-enable")` → child restart with merged env → tools register at boot → manifest-delta added.
- `env` absent → existing controllerEnv (if any from a prior `creds-update`) is preserved unchanged → no restart needed → manifest-delta added if MCP was previously unapproved.

Idempotent: `mcp-enable` for an already-enabled MCP fires the ack but produces no `manifest-delta` (nothing changed).

**Examples:**

Initial approval with creds:
```json
{
  "type": "mcp-enable",
  "mcp": "crm",
  "env": { "MOCK_CUSTOMERS_URL": "https://mock.internal:7400" },
  "source": "operator-entered"
}
```

Re-replay on register-ack, no env change:
```json
{ "type": "mcp-enable", "mcp": "crm" }
```

### `mcp-disable` (controller → connector)

```ts
interface McpDisableFrame {
  type: "mcp-disable";
  mcp: string;
}
```

Sent when the operator revokes approval in the controller UI. The connector keeps the child running — disable is a manifest-visibility toggle only. Re-enable via a fresh `mcp-enable` puts the tools back into the manifest with no spawn latency.

There is deliberately no `stop` field. If a future scenario needs to actually kill the child (RAM pressure, MCP misbehavior), a separate `mcp-stop` frame will be added in a later version. Don't overload `mcp-disable` with a boolean.

### `mcp-enable-ack` (connector → controller)

```ts
interface McpEnableAckFrame {
  type: "mcp-enable-ack";
  mcp: string;
  status: "enabled" | "disabled" | "error";
  error?: string;                 // present iff status === "error"
  toolsCount?: number;            // present iff status === "enabled"; reflects post-merge manifest
}
```

Sent in reply to every `mcp-enable` (success or error). Sent in reply to every `mcp-disable` for symmetry — same frame type, `status: "disabled"`.

**Error cases:**

| Scenario | `status` | `error` |
|---|---|---|
| Controller sent `mcp-enable` for an unknown name | `"error"` | `"unknown_mcp"` |
| Connector failed to apply env (e.g. supervisor restart errored) | `"error"` | `"apply_env_failed: <reason>"` |
| MCP is yaml-listed (gate doesn't apply) | `"error"` | `"not_gated: yaml-listed MCP, no approval needed"` |
| MCP is `controller-config` (3rd-party, gate doesn't apply) | `"error"` | `"not_gated: 3rd-party MCP, use mcp-config-snapshot"` |

**Examples:**

Success:
```json
{ "type": "mcp-enable-ack", "mcp": "crm", "status": "enabled", "toolsCount": 3 }
```

Disable success:
```json
{ "type": "mcp-enable-ack", "mcp": "crm", "status": "disabled" }
```

Error — controller approving something that isn't a drop-in:
```json
{ "type": "mcp-enable-ack", "mcp": "twilio", "status": "error", "error": "not_gated: yaml-listed MCP, no approval needed" }
```

### Frame ordering rules (v1.3)

1. `mcp-discovered` MUST precede the first `manifest-delta` for that MCP. The connector withholds the MCP's tools from the manifest until `mcp-enable` arrives.
2. After `mcp-enable` succeeds, the connector emits `manifest-delta { added: [<server descriptor>] }` BEFORE `mcp-enable-ack`. The ack is the "I'm done" signal; the manifest-delta is the actual surface change.
3. After `mcp-disable`, the connector emits `manifest-delta { removed: [<server name>] }` BEFORE `mcp-enable-ack { status: "disabled" }`.
4. `mcp-enable` for an already-enabled MCP is idempotent — no manifest-delta (nothing changed), but the ack still fires with `status: "enabled"` and the current `toolsCount`.

### Boot sequence — first-ever approval (v1.3)

```
[Connector startup]
  scan MCP_DROPIN_DIR  →  finds crm/
  spawn child via dropin-runner   (child running, tools loaded into McpServer)
  HTTP GET child:/envkeys         →  ["MOCK_CUSTOMERS_URL"]
  list child tools/list           →  [get_customer, get_recent, issue_refund]
  build manifest                  (crm tools WITHHELD — author=customer, source=local, not approved)

[Connector → Controller]   register { manifest: { servers: [...], excluding crm } }
[Controller → Connector]   register-ack { connectorId: "conn_abc" }

[Connector → Controller]   mcp-discovered { mcp: "crm", author: "customer", source: "local", envKeys: ["MOCK_CUSTOMERS_URL"], tools: [...], discoveredAt: "..." }

[Controller UI]            renders crm in "Pending approval" lane
                           operator clicks Approve, pastes MOCK_CUSTOMERS_URL value

[Controller → Connector]   mcp-enable { mcp: "crm", env: { MOCK_CUSTOMERS_URL: "https://..." }, source: "operator-entered" }

[Connector]                applyControllerEnv → supervisor restarts child → tools register → connector adds crm to approved set

[Connector → Controller]   manifest-delta { added: [{ name: "crm", tools: [3 tools with full schemas], envKeys: [...] }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }

[LLM]                      can now call crm.issue_refund
```

### Boot sequence — replay on reconnect (v1.3)

The same connector restarts (image redeploy, container restart, WS reconnect after network blip). The controller already has `crm` marked approved with persisted env from the first approval.

```
[Connector startup]                       (or WS reconnect after drop)
  scan, spawn, list tools                 (same as first-ever boot)
  build manifest                          (crm WITHHELD — connector has no approval state across restart)

[Connector → Controller]   register { manifest: { servers: [...], excluding crm } }
[Controller → Connector]   register-ack { connectorId: "conn_abc" }
[Connector → Controller]   mcp-discovered { mcp: "crm", ... }

[Controller]               looks up crm in approved table for connectorId="conn_abc"
                           found — replay enable with persisted env

[Controller → Connector]   mcp-enable { mcp: "crm", env: { MOCK_CUSTOMERS_URL: "https://..." } }

[Connector]                same as first-ever — applyControllerEnv → restart → manifest add

[Connector → Controller]   manifest-delta { added: [{ name: "crm", ... }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }
```

The connector emits `mcp-discovered` for ALL drop-ins on every register cycle, including ones the controller has already approved. This is intentional — the connector is stateless across restarts (per the v1.1 / v1.3 source-of-truth-on-controller convention). Controller-side rule: **on every `mcp-discovered`, look up `(connectorId, mcp)` in the approval table; if found, emit `mcp-enable` immediately (with stored env if any). No operator gesture required for replay.**

### Disable sequence (v1.3)

```
[Controller UI]            operator clicks Disable for crm
[Controller → Connector]   mcp-disable { mcp: "crm" }

[Connector]                supervisor.markUnapproved("crm")
                              → child KEEPS running (no stopAll, no restart)
                              → manifest rebuilt without crm's tools

[Connector → Controller]   manifest-delta { removed: ["crm"] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "disabled" }
```

Re-enable after disable is a fresh `mcp-enable` from the controller. No spawn — the child has been running. Sub-second turnaround.

### Late creds update vs `mcp-enable` (v1.3)

`mcp-enable` is for the **approval gesture**. After approval, ongoing creds rotation goes through the existing v1 `creds-update` frame, NOT through repeated `mcp-enable`s.

```
[Controller → Connector]   creds-update { mcp: "crm", env: { MOCK_CUSTOMERS_URL: "..." }, source: "operator-entered" }
[Connector]                applyControllerEnv → restart child → manifest stays same shape (no manifest-delta if tool list unchanged)
```

The controller team is encouraged to wire two distinct UI affordances — "Approve" (initial gesture, one-time per MCP) and "Edit creds" (ongoing). Don't overload `mcp-enable` for re-edits — it costs an unnecessary `manifest-delta` round-trip.

### v1.3 — Backwards compat

| Connector v1.3 + Controller v1.2 | Controller doesn't know `mcp-discovered`. The frame is logged-and-ignored per the unknown-frames rule. The MCP stays pending forever — no manifest exposure. **Fail-closed** by design. |
| Connector v1.2 + Controller v1.3 | Connector doesn't withhold tools from manifest — drop-ins auto-enable as today. Controller sees them in `manifest-delta` without prior `mcp-discovered`. Controller MUST treat any `manifest-delta` containing an unknown customer-authored MCP as implicitly approved (legacy behavior). On the next deploy of the v1.3 connector, the gate engages. |

The asymmetry favors the migration: a fresh connector against an old controller is the conservative path; a fresh controller against an old connector preserves today's behavior. Standard ship order is connector-first, controller catches up — same as v1.2 (`local-mcps-rescan`).

### v1.3 — Implementation notes for the controller team

- **Approval table schema.** A new `(connector_id, mcp_name) → { approved_at, approved_by, env_jsonb }` row in the controller's existing schema. Keyed by the connector's WS-authenticated `connectorId` AND the connector-supplied `mcp` field (folder name) — no separate mcpId for v1.3.
- **Frame ordering on the controller side.** When the operator clicks Approve, fire `mcp-enable` exactly once and wait for `mcp-enable-ack`. If the ack carries `status: "error"`, surface to the operator and do NOT retry automatically. If the ack carries `status: "enabled"`, mark the row approved and persist any env values the operator pasted.
- **Replay timing.** After receiving `register-ack`, look up every approved row for the connector and fire `mcp-enable` for each. Do this BEFORE `mcp-discovered` arrives if you can — the connector tolerates either ordering, but the operator-UX is cleaner if the manifest-delta lands before the pending-MCP UI flashes "discovered" then immediately flips to "enabled."
- **UI lane.** Surface `mcp-discovered` payloads in a separate "Pending approval" UI lane within the connector detail view, alongside the existing custom-MCPs section. Tools / descriptions are in the payload — no need to fetch the manifest. The approval form should display the `envKeys` list and let the operator paste values inline.
- **Audit log.** Approve / disable / re-edit-creds actions all SHOULD write to the controller's existing audit log (per responsibility 9 above). Stamp the operator identity at action time; the connector doesn't track who approved.
- **Frame storms on reconnect.** A connector with N unapproved drop-ins emits N `mcp-discovered` frames after `register-ack`. The 256 KB per-frame cap covers each (each frame is ~1 KB), but consider batching UI updates if N is large.

## Versioning

This document is v1.3. Revisions:
- v1.1 — adds `mcp-config-snapshot`, `mcp-config-delta`, `mcp-config-ack`, `mcp-config-resync` for controller-driven 3rd-party MCP rosters; adds optional `mcpId` to existing creds frames. Backwards-compatible per §"Backwards compat".
- v1.2 — two additive extensions:
  - `local-mcps-rescan` + `local-mcps-rescan-ack` for the controller-triggered local-MCP refresh.
  - MCP server-method passthrough (prompts / resources incl. subscribe / completions / logging) and the `mcp-notification` frame for server→client notifications. Manifest grows `prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities` per server.
  Both backwards-compatible (additive only). See §"v1.2 — MCP server-method extension" → "Backwards compat".
- v1.3 (this revision) — customer drop-in approval gate: `mcp-discovered`, `mcp-enable`, `mcp-disable`, `mcp-enable-ack`. Customer-authored drop-in MCPs no longer auto-enable; tools held back from manifest until controller approval. Backwards-compatible per §"v1.3 — Backwards compat".
- v2 — add new frame types (additive, controller MUST log+ignore unknown frames per §"Frame envelope").
- v3 — breaking change (rare). Would require a `protocol-capabilities` handshake at register time. **Not in scope today.**

When adding a frame, update this document FIRST, then implement.

## Cross-references

- [connector/src/tunnel/frames.ts](../connector/src/tunnel/frames.ts) — TypeScript type definitions for all frames.
- [connector/src/tunnel/client.ts](../connector/src/tunnel/client.ts) — connector-side WS client.
- [docs/AUTHOR-LOCAL-MCP.md](AUTHOR-LOCAL-MCP.md) — author-side walkthrough for the v1.2 drop-in shape (tools, prompts, resources).
- [CLAUDE.md](../CLAUDE.md) — connector architecture, "Wire protocol — frames" section.
