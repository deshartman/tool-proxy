# Controller handoff — Customer drop-in MCP approval gate (v1.3)

> **Audience.** Controller-side developers implementing the v1.3 wire-format additions. This document is self-contained — you do NOT need to read [MCP-PROTOCOL.md](MCP-PROTOCOL.md), [CLAUDE.md](../CLAUDE.md), or any connector source to implement against it. The wire-format extracts inline are authoritative for v1.3.
>
> **Status.** Connector implementation is in progress on branch `feature/mcp-creds-config` of the connector repo. The wire-format below is locked; the connector code lands behind a feature flag. Plan to deploy controller-side first or in parallel — backwards-compat is bidirectional (see §"Backwards compat" at the bottom).
>
> **What this document is for.** A single source of truth covering: the four new wire frames; the operator-UX surface you need to build; the persistence schema; sequences for boot, reconnect, approval, disable; backwards-compat; and edge-case handling. Read it once, implement against it. Questions go to the connector team.

## TL;DR — what changes for the controller

Today, when the connector's drop-in scanner finds a folder under `${MCP_DROPIN_DIR}/<name>/`, it spawns the child, lists its tools, and pushes them to the controller via `manifest-delta`. The controller surfaces them in its custom-MCPs section, and the LLM can call them immediately. There is **no operator-side acceptance gesture** between "folder appears on disk" and "LLM can call this tool."

This is asymmetric with how 3rd-party (Type 2) MCPs work — those require an operator to author them in the controller UI before they appear. v1.3 closes that gap for customer drop-ins.

**After v1.3, the controller is the gate.** The connector spawns the child as before but withholds the tools from the manifest. The controller learns about the MCP via a new `mcp-discovered` frame and is expected to:

1. Surface the MCP in a "Pending approval" UI lane within the connector detail view's custom-MCPs section.
2. Let the operator click **Approve** (with optional inline `envKeys` paste).
3. Send `mcp-enable` back to the connector.
4. Persist the approval row.
5. After every connector reconnect (every `register-ack`), look up the approval table and replay `mcp-enable` automatically — no operator gesture for replay.

The connector keeps no approval state across restarts. **The controller is the durable authority.** This is symmetric with how the v1.1 3rd-party MCP roster already works (controller-pushed via `mcp-config-snapshot`).

## What gates and what doesn't

| MCP type | `author` | `source` | Gated in v1.3? |
|---|---|---|---|
| Customer drop-in (folder under `${MCP_DROPIN_DIR}`) | `"customer"` | `"local"` | **YES** — requires `mcp-enable` |
| Yaml-listed Type 1 hand-written | `"customer"` or `"twilio"` | `"yaml"` | NO — yaml IS the acceptance |
| Bundled Type 3 (Twilio Python venvs) | `"twilio"` | `"yaml"` | NO — Twilio ships in image |
| Bundled Type 1 hand-written (`mcp/bundled/twilio/`) | `"twilio"` | `"yaml"` | NO — Twilio ships in image |
| 3rd-party Type 2 (controller-pushed) | `"customer"` | `"controller-config"` | NO — already operator-authored via your UI |

The connector's gate predicate is exactly `author === "customer" && source === "local"`. Anything else flows through unchanged via `manifest-delta` exactly as before. The fields are populated on every `ServerDescriptor` in the manifest you already receive.

## The four new frames

All four are line-delimited JSON over the existing `/mcp-tunnel` WSS — same envelope as every other frame. Unknown frame types MUST be logged and ignored on both sides; never close the WS for an unrecognized frame.

### 1. `mcp-discovered` (connector → controller)

The connector advertises a customer drop-in MCP whose tools are NOT yet in the manifest.

```ts
interface McpDiscoveredFrame {
  type: "mcp-discovered";
  mcp: string;                    // folder name; the wire identity, stable across reconnects
  author: "customer";             // always "customer" — bundled / yaml / 3rd-party MCPs don't go through this gate
  source: "local";                // always "local" — co-occurs with author:"customer" but kept distinct for clarity
  envKeys: string[];              // de-duped union of every tool's declared envKeys
  tools: Array<{
    name: string;                 // e.g. "issue_refund"
    description?: string;         // from the tool's register() metadata; absent if author omitted
  }>;
  discoveredAt: string;           // ISO8601, connector wall-clock
}
```

**When sent.** Two emission points:

1. **Boot.** After the connector's `register` frame and your `register-ack`, the connector emits one frame per drop-in MCP it discovered on disk. This includes MCPs the controller may have already approved in a previous session — the connector has no persistent approval state, and trusts the controller to look up `(connectorId, mcp)` and reply `mcp-enable`.
2. **Runtime rescan.** When an operator clicks **Refresh local MCPs** (v1.2 `local-mcps-rescan` flow), or when a customer drops a fresh folder, the connector spawns the child and emits one `mcp-discovered` per added MCP.

**Deliberately NOT in the payload.** Don't expect these fields:

- `inputSchema` / `outputSchema` — tool schemas; withheld until approval. They land in `manifest-delta` after enable.
- `prompts` / `resources` — for v1.3 only `tools` is gated. v1.4 may extend.
- `mcpId` — there is no controller-minted id field. The wire identity is `(connectorId, mcp-name)` end-to-end. If your DB schema needs an id, mint your own row id; just don't expect the connector to know it.

**Example payload:**

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

### 2. `mcp-enable` (controller → connector)

The controller approves the MCP. Carries optional pasted env values.

```ts
interface McpEnableFrame {
  type: "mcp-enable";
  mcp: string;                    // MUST match the folder name from mcp-discovered
  env?: Record<string, string>;   // optional — pasted creds; subset of envKeys is fine
  source?: "operator-entered";    // for connector-side telemetry / inspector display; reserved for future values
}
```

**When sent.** Two emission points:

1. **Operator approval.** New approval click in the controller UI. Operator may paste env values inline; if so, `env` is populated.
2. **Replay on register-ack.** For every previously-approved MCP, you MUST re-send `mcp-enable` after `register-ack`. This is the source-of-truth-restore mechanism.

**Behavior on the connector side:**

- `env` present → connector merges via the existing `applyControllerEnv` path → child restart with merged env → tools register at boot → connector adds the MCP to the manifest → emits `manifest-delta { added: [...] }`.
- `env` absent → connector preserves any prior controller-supplied env unchanged (no restart needed if creds haven't changed) → connector adds tools to manifest if MCP was previously unapproved.

**Idempotent.** `mcp-enable` for an already-enabled MCP is a no-op except for the ack frame (no `manifest-delta` is emitted because nothing changed). This means you don't need to track "have I sent enable for this MCP yet in this session" — just send it whenever the operator approval state says so.

**Examples.**

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

### 3. `mcp-disable` (controller → connector)

The operator revokes approval.

```ts
interface McpDisableFrame {
  type: "mcp-disable";
  mcp: string;
}
```

**Behavior on the connector side.**

- The connector drops the MCP's tools from the manifest immediately and emits `manifest-delta { removed: [<mcp>] }`.
- **The child process keeps running.** Disable is a manifest-visibility toggle, not a process-lifecycle gate. Re-enable via a fresh `mcp-enable` puts the tools back into the manifest with no spawn cost — sub-second turnaround.
- There is deliberately **no `stop` field**. If a future scenario needs to actually kill the child (RAM pressure, MCP misbehaviour), a separate `mcp-stop` frame will be added in a later version. Don't ask the connector team to overload `mcp-disable`.

### 4. `mcp-enable-ack` (connector → controller)

Sent in reply to every `mcp-enable` (success or error). Sent in reply to every `mcp-disable` for symmetry — same frame type, `status: "disabled"`.

```ts
interface McpEnableAckFrame {
  type: "mcp-enable-ack";
  mcp: string;
  status: "enabled" | "disabled" | "error";
  error?: string;                 // present iff status === "error"
  toolsCount?: number;            // present iff status === "enabled"; reflects post-merge manifest
}
```

**Error cases.** Match on `error` strings; they're stable.

| Scenario | `status` | `error` |
|---|---|---|
| Controller sent `mcp-enable` for an unknown name | `"error"` | `"unknown_mcp"` |
| Connector failed to apply env (e.g. supervisor restart errored) | `"error"` | `"apply_env_failed: <reason>"` |
| MCP is yaml-listed (gate doesn't apply) | `"error"` | `"not_gated: yaml-listed MCP, no approval needed"` |
| MCP is `controller-config` (3rd-party, gate doesn't apply) | `"error"` | `"not_gated: 3rd-party MCP, use mcp-config-snapshot"` |

**Examples.**

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

## Frame ordering rules

These are guaranteed by the connector — your implementation can rely on them:

1. **`mcp-discovered` precedes the first `manifest-delta` for that MCP.** The connector withholds tools from the manifest until `mcp-enable` arrives.
2. **`manifest-delta { added }` precedes `mcp-enable-ack { status: "enabled" }`.** The ack is the "I'm done" signal; the manifest-delta is the actual surface change. Update your tool index from the manifest-delta, then mark the approval row "live" on the ack.
3. **`manifest-delta { removed }` precedes `mcp-enable-ack { status: "disabled" }`.** Same rule as enable.
4. **Idempotent re-enable.** `mcp-enable` for an already-enabled MCP fires the ack but produces NO `manifest-delta`. Don't mark this as a transition in your UI; the operator just reaffirmed approval.

## Sequences

### Sequence A — First-ever boot, fresh customer drop-in

The connector boots for the first time. A customer dropped a folder under `${MCP_DROPIN_DIR}/crm/tools/`. Your DB has no row for `(connectorId, "crm")`.

```
[Connector startup]
  scans MCP_DROPIN_DIR  →  finds crm/
  spawns child via dropin-runner   (child running, tools loaded)
  HTTP probes child:/envkeys       →  ["MOCK_CUSTOMERS_URL"]
  lists child tools/list           →  [get_customer, get_recent, issue_refund]
  builds manifest                  (crm tools WITHHELD — gate predicate matches)

[Connector → Controller]   register { manifest: { servers: [...], EXCLUDING crm } }
[Controller → Connector]   register-ack { connectorId: "conn_abc" }

[Connector → Controller]   mcp-discovered {
                              mcp: "crm",
                              author: "customer",
                              source: "local",
                              envKeys: ["MOCK_CUSTOMERS_URL"],
                              tools: [
                                {name: "get_customer", description: "..."},
                                {name: "get_recent",   description: "..."},
                                {name: "issue_refund", description: "..."}
                              ],
                              discoveredAt: "2026-06-23T12:00:00Z"
                            }

[Controller]               look up (connectorId, "crm") in approvals table → not found
                           render crm in "Pending approval" lane of custom-MCPs section
                           operator reviews tool list, clicks Approve
                           operator pastes MOCK_CUSTOMERS_URL value

[Controller → Connector]   mcp-enable {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" },
                              source: "operator-entered"
                            }

[Connector]                applyControllerEnv("crm", env, "operator-entered", "mcp-enable")
                              → supervisor restarts child  (creds change requires restart)
                              → child re-registers tools at boot
                              → connector adds crm to in-memory approved set
                              → rebuilds manifest with crm tools included

[Connector → Controller]   manifest-delta { added: [{ name: "crm", tools: [3 tools with full schemas], envKeys: [...] }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }

[Controller]               persist approval row: (connectorId, "crm", env_jsonb, approved_at, approved_by)
                           UI flips MCP from "Pending" to "Live"

[LLM]                      can now call crm.issue_refund (and the other two)
```

**Latency budget.** From `register-ack` to `mcp-enable-ack` is operator-bound (could be seconds, could be days). The connector spawned the child unconditionally before `register`, so when approval finally arrives there's no spawn cost — just an env-driven restart, which is cheap.

### Sequence B — Reconnect with previously-approved MCP (replay path)

The same connector restarts (image redeploy, container restart, network blip). Your DB already has `(connectorId, "crm")` marked approved with persisted env from Sequence A.

```
[Connector startup]                       (or WS reconnect after drop)
  scan, spawn, list tools                 (same as Sequence A)
  build manifest                          (crm WITHHELD — connector has no approval state across restart)

[Connector → Controller]   register { manifest: { servers: [...], EXCLUDING crm } }
[Controller → Connector]   register-ack { connectorId: "conn_abc" }

[Connector → Controller]   mcp-discovered { mcp: "crm", ... }

[Controller]               look up (connectorId, "crm") in approvals table → FOUND
                           replay enable with persisted env from the row

[Controller → Connector]   mcp-enable {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" }
                            }

[Connector]                same as Sequence A — applyControllerEnv → restart → manifest add

[Connector → Controller]   manifest-delta { added: [{ name: "crm", ... }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }
```

**Critical for the controller team.** The connector emits `mcp-discovered` for **all** drop-ins on every register cycle, including ones you've already approved. This is intentional — the connector is stateless across restarts.

**Your responsibility:** **on every `mcp-discovered`, look up `(connectorId, mcp)` in the approval table; if found, emit `mcp-enable` immediately (with stored env if any).** No operator gesture required for replay.

### Sequence C — Operator revokes approval

Operator clicks Disable in your UI for the `crm` MCP.

```
[Controller UI]            operator clicks Disable for crm
[Controller]               update approvals row: status=revoked, revoked_at=now, revoked_by=operator_id

[Controller → Connector]   mcp-disable { mcp: "crm" }

[Connector]                supervisor.markUnapproved("crm")
                              → child KEEPS running (no stopAll, no restart)
                              → manifest rebuilt without crm's tools

[Connector → Controller]   manifest-delta { removed: ["crm"] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "disabled" }

[LLM]                      crm.issue_refund returns "tool not found" via your normal dispatch
```

**Re-enable after disable** is a fresh `mcp-enable` from your UI. No spawn — the child has been running. Sub-second turnaround.

### Sequence D — Operator updates creds for an approved MCP

After approval, ongoing creds rotation goes through the existing v1 `creds-update` frame, **NOT** through repeated `mcp-enable`.

```
[Controller UI]            operator edits MOCK_CUSTOMERS_URL value, clicks Save

[Controller → Connector]   creds-update {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock-v2.internal:7400" },
                              source: "operator-entered"
                            }

[Connector]                applyControllerEnv → restart child → manifest stays same shape
                           (tool list didn't change, so no manifest-delta is emitted)
```

Wire two distinct UI affordances in your code: **Approve** (initial gesture, one-time per MCP) and **Edit creds** (ongoing rotation). Don't overload `mcp-enable` for re-edits — it costs an unnecessary `manifest-delta` round-trip.

### Sequence E — Runtime drop-in (W-L2 rescan path)

The connector is already running. The customer drops a new folder `mcp/local/inventory/tools/` and an operator clicks **Refresh local MCPs** in your UI (or the customer-author hits the loopback rescan endpoint on the inspector).

```
[Trigger]                  EITHER inspector POST /mcp/rescan-local (loopback, no controller round-trip)
                           OR     [Controller → Connector] local-mcps-rescan {}

[Connector]                LocalMcpsCoordinator.rescan()
                              → discoverDropins({yamlNames})
                              → diff vs running supervisor entries with source==="local"
                              → ADDED: inventory
                              → registerOne(spec, {source: "local"})
                              → startOne("inventory")    (child spawns)
                              → fetchEnvKeys("inventory")  (HTTP probe)

[Connector → Controller]   mcp-discovered {
                              mcp: "inventory",
                              author: "customer",
                              source: "local",
                              envKeys: [...],
                              tools: [...],
                              discoveredAt: "..."
                            }
[Connector → Controller]   local-mcps-rescan-ack {
                              added:     [{name: "inventory", toolsCount: 2}],
                              removed:   [],
                              unchanged: ["sample", "crm"],
                              errors:    []
                            }

[Controller UI]            "Done — 1 added" toast (from rescan-ack)
                           inventory appears in Pending lane (from mcp-discovered)
                           — operator approval flow continues like Sequence A —
```

Both frames are independent — the rescan-ack carries the diff summary for the toast, and the `mcp-discovered` carries the approval-form data for the Pending lane.

### Sequence F — Race / orphan: operator approves an unknown MCP

The customer deleted the folder between `mcp-discovered` and the operator clicking Approve. Or your DB got out of sync (e.g. stale backup). Result: you sent `mcp-enable` for a name the connector doesn't know.

```
[Controller → Connector]   mcp-enable { mcp: "ghost" }

[Connector]                no entry "ghost" in supervisor — no manifest change, no env apply

[Connector → Controller]   mcp-enable-ack { mcp: "ghost", status: "error", error: "unknown_mcp" }
```

**Recovery rule.** Log the error in your audit log. Mark the approval row as orphaned (or hidden from the operator UI). Do NOT retry automatically — the next `mcp-discovered` (if the folder reappears) is the natural recovery point.

A reasonable UX: when the controller receives `mcp-enable-ack { status: "error", error: "unknown_mcp" }` while the operator is still on the approval screen, show "MCP no longer present on the connector — refresh and retry" rather than a generic error.

### Sequence G — Folder deleted on disk after approval

A customer deletes `mcp/local/inventory/` from disk and an operator triggers a rescan.

```
[Trigger]                  same as Sequence E

[Connector]                LocalMcpsCoordinator.rescan()
                              → diff: REMOVED: inventory
                              → supervisor.unregister("inventory")  (child SIGTERM'd)

[Connector → Controller]   manifest-delta { removed: ["inventory"] }   (if inventory was approved)
[Connector → Controller]   local-mcps-rescan-ack {
                              added:     [],
                              removed:   ["inventory"],
                              unchanged: ["sample", "crm"],
                              errors:    []
                            }
```

**The approval row stays in your DB** marked approved-but-orphaned. If the customer later drops a folder with the same name, the next `mcp-discovered` triggers the replay path (Sequence B) and the approval auto-applies.

If you want to garbage-collect orphaned rows, that's your call. Two reasonable policies:

- **Keep forever.** Fastest re-onboarding — the customer drops a folder with the same name and it just works.
- **Expire after N days of orphan.** Cleans up DB drift; forces re-approval if the folder reappears after expiry.

The connector doesn't care which you pick.

## Persistence schema (suggested)

A new table keyed on `(connector_id, mcp_name)`. Approval state is the controller's durable authority.

```sql
CREATE TABLE customer_mcp_approvals (
  connector_id        UUID    NOT NULL,        -- FK to your existing connectors table
  mcp_name            TEXT    NOT NULL,        -- the wire `mcp` field; folder name on the connector
  status              TEXT    NOT NULL,        -- "approved" | "revoked"
  env                 JSONB,                   -- pasted env values; subset of envKeys is fine
  approved_at         TIMESTAMPTZ NOT NULL,
  approved_by         UUID,                    -- operator user id
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID,
  last_replay_at      TIMESTAMPTZ,             -- updated on every replay-on-register-ack
  PRIMARY KEY (connector_id, mcp_name)
);
```

Notes:

- **Wire identity is `(connectorId, mcp_name)`.** Don't introduce a controller-minted `mcpId` — there's no equivalent for v1.3, unlike the v1.1 3rd-party MCP roster which does use `mcpId`.
- **`env` JSONB is your storage choice.** The connector only needs the `Record<string, string>` shape on the wire. If your security posture requires encrypting it at rest, do so — the connector receives plaintext over the WSS (already TLS-protected) and never persists it.
- **`last_replay_at`** is optional but useful for "is this connector receiving replays correctly" diagnostics.
- **A `revoked` row stays in the table.** The operator can re-approve later. If you want hard-delete on revoke, that's also fine — the connector handles either.

## UI surface — the operator's view

The new affordance lives in the connector detail view's existing custom-MCPs section. Suggested layout:

**Custom MCPs tab.** Three lanes (sub-tabs or sections):

1. **Pending approval** — populated from `mcp-discovered` frames where `(connectorId, mcp)` has no `approved` row.
   - Shows MCP name, list of tool names + descriptions, list of `envKeys`.
   - Approve button opens an inline form with the `envKeys` as labelled inputs (operator can leave them blank if not yet known).
   - Submitting fires `mcp-enable { mcp, env, source: "operator-entered" }` and waits for the ack.
2. **Live** — populated from `mcp-discovered` frames where `(connectorId, mcp)` has an `approved` row, OR from `manifest-delta` entries with `author: "customer", source: "local"`.
   - Shows MCP name + tool list with full schemas (now visible because they're in the manifest).
   - **Edit creds** button → fires `creds-update`.
   - **Disable** button → fires `mcp-disable`.
3. **Orphaned** (optional) — approval rows whose folder is no longer on the connector. Driven by the absence of recent `mcp-discovered` frames + a `manifest-delta { removed }` since approval. Showing this lane is optional.

**Field hints to render on the approval form:**

- The `description` from each tool gives the operator enough context to decide.
- The `envKeys` list tells the operator what creds they can paste — but the operator MAY leave them blank and add later via Edit creds. The connector handles both paths identically.
- Show the `discoveredAt` timestamp so the operator knows how recently the customer dropped the folder.

## Frame storms on reconnect

A connector with N unapproved drop-ins emits N `mcp-discovered` frames after `register-ack`. The 256 KB per-frame cap covers each (each frame is ~1 KB), but consider batching UI updates if N is large — the controller might receive 20+ `mcp-discovered` frames in <100ms after reconnect.

Reasonable mitigation: collect frames into a buffer for ~250ms after `register-ack`, then re-render the Pending lane once with all of them. Don't gate `mcp-enable` replay on the buffer — fire those immediately as each `mcp-discovered` arrives.

## Audit logging

Every `mcp-enable` / `mcp-disable` / Edit creds gesture SHOULD write to your existing audit log (per the v1 protocol's responsibility 9):

- Operator identity (from your session).
- Action (approve / disable / edit-creds).
- Connector + MCP name.
- Timestamp.

The connector doesn't track who approved — it doesn't have a user model. Stamp the operator at action time on your side.

## Backwards compat

The v1.3 frames are additive. The unknown-frame rule from earlier protocol versions still applies: unknown frame types MUST be logged and ignored on both sides. This makes both deploy orderings safe:

| Scenario | Behavior |
|---|---|
| **Connector v1.3, Controller v1.2 (no v1.3 support yet)** | Controller doesn't know `mcp-discovered` — logs+drops the frame. Connector never receives `mcp-enable`. The MCP stays pending forever — no manifest exposure. **Fail-closed by design.** |
| **Connector v1.2, Controller v1.3 (controller deployed first)** | Connector doesn't withhold tools from manifest — drop-ins auto-enable as today. Controller sees them in `manifest-delta` without prior `mcp-discovered`. Controller MUST treat any `manifest-delta` entry with `author: "customer", source: "local"` AND no prior `mcp-discovered` as legacy auto-enabled — implicitly approved, no operator gesture required. On the next deploy of the v1.3 connector, the gate engages and the frame ordering normalizes. |

**Recommended ship order: connector-first.** Deploy the v1.3 connector to a few canary tenants, confirm the controller's logs+drops behavior is benign, then deploy the v1.3 controller in a follow-up.

If the controller ships first, the legacy auto-enable behavior continues from older connectors — handle it gracefully:

```ts
// Controller-side handling pseudocode
function onManifestDelta(delta) {
  for (const server of delta.added) {
    if (server.author === "customer" && server.source === "local") {
      const approval = db.findApproval(connectorId, server.name);
      if (!approval) {
        // No prior mcp-discovered for this MCP — connector is v1.2 or older.
        // Treat as legacy auto-approved; persist the row.
        db.upsertApproval({
          connector_id: connectorId,
          mcp_name: server.name,
          status: "approved",
          approved_at: now(),
          approved_by: null,             // no operator action — stamped as system-approved
          source_note: "legacy_auto_enable",
        });
      }
    }
  }
}
```

## Implementation checklist (controller side)

Use this as your PR-by-PR delivery list. Each item is independent; ship in the order that fits your sprint.

### Wire-format support
- [ ] Add `McpDiscoveredFrame`, `McpEnableFrame`, `McpDisableFrame`, `McpEnableAckFrame` types to your TS definitions (or equivalent for your stack).
- [ ] Add round-trip parse / serialize tests.
- [ ] Verify the unknown-frame rule still works — sending a `mcp-discovered` from a test harness against the current controller should log+drop without disconnecting the WS.

### Persistence
- [ ] Migrate the `customer_mcp_approvals` table (or your equivalent shape).
- [ ] Backfill: a v1.2 connector currently auto-enabled — when the v1.3 controller goes live, all existing customer-drop-in MCPs in the live manifest should be marked `approved` with `source_note: "legacy_auto_enable"` so they don't ALL appear in the Pending lane on first connect.

### Frame handling
- [ ] On `mcp-discovered`: look up `(connectorId, mcp)`. If approved → emit `mcp-enable` with stored env. If not → push to Pending lane.
- [ ] On `mcp-enable-ack { status: "enabled" }`: mark approval row "live", update last_replay_at.
- [ ] On `mcp-enable-ack { status: "disabled" }`: mark approval row revoked.
- [ ] On `mcp-enable-ack { status: "error" }`: log to audit, surface to operator if they're on the approval screen.
- [ ] Add a per-WS-session buffer for `mcp-discovered` frames so reconnect with N drop-ins doesn't thrash the UI.

### UI
- [ ] Add Pending / Live / Orphaned (optional) lanes to the connector detail view's custom-MCPs section.
- [ ] Approval form: show tool names + descriptions, render `envKeys` as labelled inputs, allow blank submission.
- [ ] Live lane: show full tool list (from manifest), Edit creds button (`creds-update`), Disable button (`mcp-disable`).
- [ ] Wire toast for `local-mcps-rescan-ack` ("Done — N added, M removed") since that frame already fires today.

### Audit
- [ ] Stamp every approve / disable / edit-creds with operator identity.
- [ ] Include `connectorId`, `mcp_name`, `action`, `timestamp`.

### Tests
- [ ] End-to-end: harness emits `mcp-discovered` → controller persists pending → operator approves → controller emits `mcp-enable` → harness emits `manifest-delta + mcp-enable-ack` → controller marks live.
- [ ] Replay path: controller restart → harness reconnects → all approved rows emit `mcp-enable` after `register-ack`.
- [ ] Error path: `mcp-enable-ack { status: "error", error: "unknown_mcp" }` → controller marks orphaned, surfaces UX.
- [ ] Backwards compat: a v1.2 manifest-delta with a customer drop-in (no prior `mcp-discovered`) gets auto-approved with the legacy marker.

## FAQ

**Q: What if the connector has zero customer drop-ins on disk?**
A: No `mcp-discovered` frames fire. The Pending lane is empty. Yaml-listed MCPs and 3rd-party MCPs flow through the normal manifest as today.

**Q: What if the operator approves an MCP but the connector immediately disconnects before `mcp-enable-ack`?**
A: Persist the approval row when the operator clicks Approve, BEFORE waiting for the ack. On next reconnect's `register-ack`, the replay path picks it up. If the connector permanently disappears, the row is orphaned but harmless.

**Q: Can the same MCP name appear under both yaml and drop-in?**
A: No. The connector's drop-in scanner skips folders whose name is already in `connector.yaml`. So if the customer adds a yaml entry named `crm`, the drop-in scanner doesn't see `mcp/local/crm/` — and you'll receive that `crm` in the manifest as `source: "yaml"`, NOT as `mcp-discovered`. Conversely, a drop-in is only ever `source: "local"`. Your gate logic on `(author === "customer" && source === "local")` is the safe predicate.

**Q: What if the operator pastes WRONG creds during approval?**
A: The connector applies them, restarts the child, and the child's tool calls fail at runtime with whatever error the underlying API returns (401, etc.). The MCP is "live" from the controller's perspective — the connector doesn't health-check creds. Operator recovery is **Edit creds** (`creds-update`).

**Q: Can the operator approve an MCP without entering any creds?**
A: Yes. Send `mcp-enable { mcp }` with no `env` field. Connector marks approved, manifest-delta adds the tools. Tool calls that need missing creds will fail at runtime; operator follows up with Edit creds when ready. This pattern is useful when an operator wants to approve the MCP's existence first and gather creds later.

**Q: Does the connector emit `manifest-delta` for the MCP entering Pending state?**
A: No. The MCP is never in the manifest while pending. The first `manifest-delta` containing the MCP fires after `mcp-enable` succeeds. From the controller's wire perspective: pending MCPs exist only via `mcp-discovered`, never via `manifest-delta`.

**Q: What if two operators race-approve the same MCP from different sessions?**
A: The connector handles `mcp-enable` idempotently — second click is a no-op except for the ack. UPSERT semantics on the controller's approvals table handles the persistence side. Both operators see "approved" in their UI; whichever wrote second wins on `env` + `approved_by`.

**Q: How does this interact with the inspector's loopback rescan endpoint?**
A: The inspector's `POST /mcp/rescan-local` is a local-dev-only path that triggers the same `LocalMcpsCoordinator.rescan()` as the controller's `local-mcps-rescan` frame. The new MCPs spawn and emit `mcp-discovered` to the controller exactly like a controller-triggered rescan. The inspector itself can NOT approve MCPs — only the controller can — but the connector's inspector UI WILL render pending MCPs with a `pending` badge so the local-dev customer can see "yes, the connector found my folder, now I need an operator to approve it."

**Q: Is there a way to bypass the gate for local development?**
A: Not in v1.3. If real friction emerges from "every drop-in needs an operator approval click," the connector team has flagged a possible v1.4 dev-mode env flag (`CONNECTOR_AUTO_APPROVE_DROPINS=1`) that self-approves at the connector. Until then, the controller is the gate, full stop. Don't rely on a bypass that doesn't exist yet.

## Cross-references

- [docs/MCP-PROTOCOL.md](MCP-PROTOCOL.md) §"v1.3 — Customer drop-in approval gate" — the connector-side authoritative spec. Same content as this doc, slightly different orientation (connector-first vs controller-first). If they ever drift, MCP-PROTOCOL.md wins.
- [docs/AUTHOR-LOCAL-MCP.md](AUTHOR-LOCAL-MCP.md) — what the customer authoring a drop-in MCP sees. Reference if you want to understand the customer's authoring workflow.
- [packages/connector/src/tunnel/frames.ts](../packages/connector/src/tunnel/frames.ts) — TS type definitions on the connector side. Same shapes as in this doc.
- [CLAUDE.md](../CLAUDE.md) §"Three MCP integration patterns" + §"Architecturally load-bearing properties" — connector architecture overview. Read if you want to understand WHY the gate is structured this way.

## Questions

For implementation questions, contact the connector team. The wire-format above is locked once the connector ships v1.3 — any changes need to go through MCP-PROTOCOL.md first, then connector code, then this doc.
