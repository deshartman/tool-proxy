# CONNECTOR-ID-AS-IDENTITY — server-mint connector identity, drop operator-typed name

> **Status:** ready to execute, **2026-07-12**. Branch: **`feature/env-to-db`** (this work ships as part of the same PR — env-to-db + identity simplification land together). Prerequisite: controller-side change coordinated (see §"Controller-side changes required"). URL-normalize prep landed already (`3a0ae79`).
>
> **Scope:** replace the operator-typed `Connector name` identity claim with a server-minted `conn_...` ID. The Configure Tunnel modal collapses to two required fields: **Controller URL** + **Tunnel auth token**. Everything else — the connector's identity, display name, environment, region — is server-authoritative and lives on the controller UI, never on the connector.
>
> **Companion docs.**
> - [`ENV-TO-DB.md`](ENV-TO-DB.md) — the storage-layer migration this rides on top of. The schema addition here (`connector_id` column) lands on the `controllers` table that plan introduced.
> - [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md) — Phase-2 multi-controller design. This plan is orthogonal but complementary: server-minted IDs are exactly what a multi-row `controllers` table needs.

## TL;DR

Today (post-ENV-TO-DB, pre-this-plan) the operator pastes 5 things into the Configure Tunnel modal: Controller URL, Row label, Connector name, Environment, Tunnel auth token. The `Connector name` doubles as the identity claim — the WS upgrade sends `X-Connector-Name: <name>` and the controller looks up the `connectors` table by that name. Mismatches cause `organisation_has_connector` rejections; the docs get this wrong repeatedly because there are two similarly-named rows on the controller side (Tunnel Security "MCP Sec" vs MCP Tunnel "mcp-tunnel").

Target: **two required fields.** Controller URL + Tunnel auth token. On first connect the controller mints the `connectors` row automatically, returns `connectorId` in the register-ack, and the connector persists it. Every subsequent connect sends `X-Connector-Id: conn_...` — a primary-key lookup, no name matching. Display name, environment, region become editable-on-controller-UI fields the connector doesn't know or care about.

| Field | Today | After |
|---|---|---|
| Controller URL | operator paste | operator paste (auto-normalized to base URL — landed `3a0ae79`) |
| Tunnel auth token | operator paste | operator paste |
| Connector name | operator paste, must-match | **removed** — server-minted `conn_...` ID |
| Row label | operator paste, cosmetic | **removed** — Controller URL IS the identifier |
| Environment | operator paste, decorative | **removed** — controller-side only |
| Auth mode radio | radio (static / OAuth2) | disclosure link (`▸ Use OAuth2 instead`) |

The controller team is coordinating the server-side changes in parallel; this plan focuses on connector-side execution.

## Motivation

1. **Name-mismatch friction is a real support-ticket source.** The `organisation_has_connector` recovery we hit during first-real-boot verification (2026-07-11) needed a manual script + database seed. Under server-minted IDs, that failure mode doesn't exist — every fresh connector mints a fresh row.
2. **The `conn_...` ID already exists as the primary key** on the `connectors` table (`conn_ebf0b807` in the reference deployment). Keeping the operator-typed name as the identity claim is a legacy artifact from before the server minted stable IDs.
3. **Two similarly-named controller-side rows caused sustained docs drift.** The modal, CLAUDE.md, and README all said "must match the Tunnel Security row name" for weeks — wrong (should have been MCP Tunnel row name), but the docs happened to work in early deployments where both rows shared a name. Removing the operator-typed field removes the class of confusion.
4. **Cosmetic tags belong on the controller UI, not on the connector.** Name, Environment, Region are operator bookkeeping — helpful when running multiple connectors, but useless when the connector itself just needs to bind to one row and dial. Moving them off the connector side simplifies the operator surface and the connector schema simultaneously.

## Non-goals

- **Change the Tunnel Security row shape.** `ts_...` bearer + Twilio SID + Auth Token flow unchanged.
- **Rename the display column on the controller UI.** The `Name` field stays as a UI label — freely editable, doesn't affect binding.
- **Auto-detect static-bearer vs OAuth2 from the pasted value.** Both remain explicit choices; OAuth2 just moves behind a disclosure link.
- **Multi-controller support.** Phase-1 keeps the one-row-only invariant from ENV-TO-DB. Multi-controller belongs to MULTI-ACCOUNT.
- **Migrate away from `registrationToken`.** The token is orthogonal — it's the anti-replay claim, not the identity claim. It stays.

## Target UX

### Controller side

1. Operator creates a Tunnel Security row: paste Twilio Account SID + Auth Token → controller mints `ts_...` bearer, shown once, operator copies it.
2. **That's the entire controller-side setup.** No MCP Tunnel row to create manually — that's now server-minted on first connect.

Nice-to-have controller UI polish (independent of this plan): "Copy base URL" button on the Tunnel Security row that copies just the controller's HTTPS root, alongside the already-shown bearer. Removes the last operator paste of a value they have to know out-of-band. (Coordinated with controller team.)

### Connector side — the modal

```
┌──────────────────────────────────────────────────┐
│ Configure tunnel                                 │
│                                                  │
│  Controller URL                                  │
│  [https://your-controller.example.com]           │
│                                                  │
│  Tunnel auth token                               │
│  [ts_·································]         │
│                                                  │
│  ▸ Use OAuth2 client_credentials instead         │
│                                                  │
│                    [Cancel]  [Save & connect]    │
└──────────────────────────────────────────────────┘
```

Two required inputs, one submit. The OAuth2 disclosure expands to three OAuth fields (client_id, client_secret, token_url) and hides the Tunnel auth token field.

### Configured state readout

```
Controller URL       https://your-controller.example.com
Connector ID         conn_ebf0b807
Auth mode            static-bearer  [set]
Registration         bound (len=36)
Last connected       12s ago

                                            [Edit] [Force re-registration]
```

`Connector ID` — copied verbatim from the DB row after first successful register-ack. Immutable, operator-invisible until the first mint. Never editable from the connector side.

### First-boot flow

1. Operator boots connector for the first time. Empty DB. Inspector shows "Configure tunnel" CTA.
2. Modal: paste Controller URL + bearer, click Save & connect.
3. Connector seals bearer into `controllers.tunnel_auth_token_ct`, upserts the row with `connector_id = NULL`.
4. Connector dials the tunnel. WS upgrade sends `Authorization: Bearer <ts_...>` — NO `X-Connector-Name`, NO `X-Connector-Id`.
5. Controller: bearer verifies. No connector-ID header → mint a fresh `connectors` row, auto-generate display name, return `{connectorId, registrationToken}` in register-ack.
6. Connector persists both. `controllers.connector_id = "conn_..."`, `controllers.registration_token_ct = seal("tok_...")`.
7. Inspector flips to configured state. Every subsequent reconnect sends `X-Connector-Id: conn_...`.

## Wire protocol changes

### WS upgrade headers

Before:
```
Authorization: Bearer <ts_...>
X-Connector-Name: <name>   # required
```

After:
```
Authorization: Bearer <ts_...>
X-Connector-Id: <conn_...>   # sent when the connector has a persisted ID
```

Rules:
- First connect: neither header. Controller mints fresh row and returns ID.
- Post-first-connect: `X-Connector-Id` sent. `X-Connector-Name` is gone entirely (nothing to fall back to — this is a same-branch atomic swap, no cross-release migration since env-to-db hasn't merged yet).

### register-ack response body

Before:
```json
{ "type": "register-ack", "registrationToken": "tok_..." }
```

After:
```json
{ "type": "register-ack", "connectorId": "conn_...", "registrationToken": "tok_..." }
```

`connectorId` is echoed on every register-ack (not just first mint). Reserved for future scenarios where the ID might be re-issued (Phase-2 multi-account edge cases).

## Connector-side schema

Add one column to `mcp_connector.controllers`:

```sql
ALTER TABLE mcp_connector.controllers ADD COLUMN connector_id TEXT;
```

- Nullable — a fresh install has no ID until first register-ack.
- Not indexed — we only ever query the row by its own `id` (UUID) locally; `connector_id` is a wire-facing value.
- Populated by `store.updateConnectorId(id, connectorId)` from the register-ack handler. Same shape as `updateRegistrationToken`.

Drop these columns from `ControllerRow` / `ControllerInput` / `TunnelConfigSummary` / the modal / the DDL:

- `connector_name` — no operator paste, no wire use
- `environment` — controller-owned metadata; connector doesn't display it

Keep `name` (the free-form row label) on the DB row schema temporarily as nullable, populated with a default like `"tunnel"` on insert. Removing it entirely requires touching every existing query and gaining nothing (it's not on the wire either). Deprecate quietly.

## Controller-side changes required

**Owned by the controller team; you are coordinating.** From the connector's perspective:

1. **Accept WS upgrade with no `X-Connector-Name` and no `X-Connector-Id` header.** Currently rejects. Change to: mint a fresh `connectors` row with an auto-generated display name.
2. **Accept `X-Connector-Id: <conn_...>` header.** Primary-key lookup on `connectors`.
3. **Return `connectorId` in every register-ack.** Register-ack today only returns `registrationToken`; extend to include `id`.
4. **Auto-generate display name on fresh mint.** Suggested pattern: `{tunnel-security-row-name}-{random-4-hex}` — origin is obvious in the UI. Or a plain UUID slug if the security row name is unhelpful.
5. **UI polish (nice-to-have): "Copy base URL" button on the Tunnel Security row.** Copies just the HTTPS root; removes the last operator paste of an out-of-band value.

## Task sequence — on `feature/env-to-db`

Execute in order. Each step has an explicit acceptance criterion. Do not proceed to the next step until the current criterion passes.

### Step 0 — Prerequisites `[COORDINATED]`

Controller team has landed the four required changes (accept name-less upgrade, accept `X-Connector-Id`, return `connectorId` in register-ack, auto-mint display name). Verify by hand-crafting a WS upgrade with no name header against the target controller URL and confirming register-ack carries `connectorId`. Do not start Step 1 until this passes.

Acceptance: manual curl-and-wscat against the controller returns a `register-ack` frame containing a `connectorId` field.

### Step 1 — Schema migration + `ConfigStore.updateConnectorId` `[OFFLINE OK]`

Edit `packages/connector/src/config-store/schema.ts`:
- Add `connector_id TEXT` column to the `controllers` table DDL.
- Remove `environment TEXT` column (was `nullable`; connector no longer stores it).
- Keep `connector_name` for now — nullable — to avoid rewriting existing queries. Will be removed in a follow-up cleanup.

Edit `packages/connector/src/config-store/index.ts`:
- Add `connectorId: string | null` to `ControllerRow`. Remove `environment` from `ControllerRow` and `ControllerInput`.
- Add `updateConnectorId(id: string, connectorId: string): Promise<void>` method — same shape as `updateRegistrationToken`.
- Update `getController` decoder to read `connector_id` from the row.
- Update `upsertController` INSERT — no longer takes `environment`; hardcode `connector_name` = `"tunnel"` on insert (or drop the column reference).

Add tests to `config-store.test.ts` — round-trip a row with `connectorId` set/unset, cover `updateConnectorId`.

Acceptance: `npm test` passes. Existing `config-store.test.ts` cases updated to drop `environment` assertions.

### Step 2 — Wire protocol: emit `X-Connector-Id`, parse `connectorId` from register-ack `[OFFLINE OK]`

Edit `packages/connector/src/tunnel/client.ts`:
- Constructor gains a `connectorId?: string` parameter (or reads it from a getter). If present, add `X-Connector-Id: <connectorId>` to the WS upgrade headers.
- Remove the `X-Connector-Name` header emission entirely — nothing to send there anymore.

Edit `packages/connector/src/tunnel/frame-router.ts`:
- Parse `connectorId` from the register-ack frame body.
- Add an optional `onConnectorId(connectorId: string)` callback in `FrameRouterConfig`. Fire it when the register-ack carries an ID.

Acceptance: `tsc -b` compiles; existing `tunnel/client` tests updated for the removed name header.

### Step 3 — Wire `bootFromDb` to persist the ID `[OFFLINE OK]`

Edit `packages/connector/src/boot/lifecycle.ts`:
- In `bootFromDb`, thread `row.connectorId ?? undefined` through to the `TunnelClient` constructor.
- Wire the `onConnectorId` frame-router hook: `await store.updateConnectorId(row.id, connectorId); row = await store.getController();` — one-shot per fresh ID, no-op if the DB already holds it.
- The `dialTunnel` closure the inspector wires must also pull the fresh `connectorId` after upsert (rare edge case: operator paste completes upsert, dial fires, controller mints ID, connector persists, next dial reuses).

Acceptance: manual smoke test — boot with empty DB, paste URL + bearer, verify the DB row's `connector_id` populates after first register-ack. Confirm subsequent reconnects send `X-Connector-Id`.

### Step 4 — Modal: collapse to two fields `[OFFLINE OK]`

Edit `packages/connector/public/index.html`:
- Remove: `name` (Row label), `connectorName`, `environment` input fields.
- Keep: `controllerUrl`, `tunnelAuthToken`, OAuth2 fieldset.
- Reshape the OAuth2 selector from a radio group into a disclosure link (`▸ Use OAuth2 client_credentials instead`) that hides the bearer field and shows the OAuth fields when clicked. Static-bearer is the default; the disclosure is one click away.

Edit `packages/connector/public/app.js`:
- Remove the `name` / `connectorName` / `environment` form-reading logic from the submit handler.
- The `ControllerInput` payload sent to POST `/creds` becomes `{controllerUrl, authMode, tunnelAuthToken}` for static-bearer or `{controllerUrl, authMode, oauthClientId, oauthClientSecret, oauthTokenUrl}` for OAuth2.
- Update `renderTunnelConfigured` — remove `Environment` and `Connector name` rows from the readout; add `Connector ID` row.

Edit `packages/connector/src/inspector/tunnel-routes.ts`:
- `TunnelConfigSummary` type gains `connectorId: string | null`, drops `name` / `connectorName` / `environment`.
- `handlePostCreds`'s payload validation drops those fields (they were required before).
- Server-side, `upsertController` still needs to receive SOME value for the row's DB `name` column — hardcode to `"tunnel"` in the handler for now.

Acceptance: manual smoke test — Configure Tunnel modal shows exactly two fields (URL, bearer) + the OAuth2 disclosure. Save & connect works. Configured readout shows `Connector ID`.

### Step 5 — Leak-channel tests updated `[OFFLINE OK]`

Extend `packages/connector/tests/inspector/tunnel-creds-leak.test.ts` — the sentinel-grep pattern for `connectorId` (not a secret, but making sure the response doesn't accidentally echo more than intended). Also verify that removed fields (`name`, `environment`) no longer appear in responses.

Acceptance: leak tests still pass; sentinels for the new `connectorId` field don't trip.

### Step 6 — Docs update `[OFFLINE OK]`

Update:
- **CLAUDE.md §"Identity established at WS register-frame time"** — rewrite to describe the new flow (server-mint on first connect, `X-Connector-Id` header). Remove the "Tunnel Security row name" wording that's now doubly wrong.
- **CLAUDE.md §"Config files"** — drop `Environment` and `Name` from the operator paste list.
- **packages/connector/README.md** Quick Start §"Configure tunnel creds — two modes" — reduce db-mode walkthrough to two paste fields.
- **`.env.example`** — no changes (connector name was never in .env under db mode).

Acceptance: no doc claims a Connector name is required; no doc lists Environment as a field to paste.

### Step 7 — Regression: TDZ pins updated for schema change `[OFFLINE OK]`

`packages/connector/tests/boot/lifecycle-tdz.test.ts` iterates the `CAPTURED_BY_EMPTY_DB_FLOW` list of identifiers. If any new binding is introduced in `bootFromDb` for `connectorId` handling, add it to that list. Same discipline as before: any binding a callback reads must be declared above the empty-DB return.

Acceptance: `lifecycle-tdz.test.ts` passes; no TDZ errors when clicking Save & connect from empty-DB state.

### Step 8 — Commit + rejoin the ENV-TO-DB merge flow `[OFFLINE OK]`

Once Steps 1–7 pass, commit each step under a `feat(env-to-db)` or `feat(connector-id)` prefix on `feature/env-to-db`. Then this plan's work is folded into the ENV-TO-DB PR — proceed with `ENV-TO-DB.md` Step 13's `--no-ff` merge to `main`.

Acceptance: 381+ tests pass; the connector's modal shows two fields; the DB row correctly stores `connector_id` post-register-ack.

## Migration story

**None needed.** Since this ships on `feature/env-to-db` before its first merge to `main`, no existing customer has ever seen the pre-simplification modal in production. The `.connector-state.json` → DB row migration story (`scripts/migrate-registration-token.mjs`) already exists for env-mode holdouts, and it doesn't touch identity — it only migrates the `registrationToken`. The connector picks up its `connectorId` on the next register-ack automatically.

**Development-only edge case:** you (the operator running this branch in dev) currently have a DB row with `connector_id = NULL` and a name-based binding on the controller. When the controller-side change lands, your next register-ack will carry the new `connectorId` — the connector will persist it and switch to `X-Connector-Id` on the reconnect after that. No manual step required. If you want to force it, delete the DB row and reconfigure from scratch.

## Open questions

Only the coordination piece — **the controller-side spec** is what decides:
1. Auto-generated display name pattern (`{security-row-name}-{4hex}` vs plain UUID slug).
2. Whether one Tunnel Security row can back multiple connectors (currently supported implicitly; ID-based lookup doesn't change this).
3. Timing of the "Copy base URL" button on the Tunnel Security page — independent controller-side polish, not gating this plan.

Nothing else is ambiguous. Connector-side execution is deterministic once the controller change lands.
