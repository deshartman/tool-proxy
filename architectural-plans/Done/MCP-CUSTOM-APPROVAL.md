# MCP-CUSTOM-APPROVAL — Plan

> **Status: completed 2026-06-23.** All five stages (W-A1..W-A5) merged on `feature/mcp-creds-config`. Connector-side ships the gate; controller-side counterpart in [`AgenticProcedure/.claude/plans/`](../../../AgenticProcedure/.claude/plans/) is the dev's responsibility — they have [`docs/CONTROLLER-HANDOFF-MCP-APPROVAL.md`](../docs/CONTROLLER-HANDOFF-MCP-APPROVAL.md) as the self-contained spec.

> **Goal.** Make customer-authored drop-in MCPs go through an explicit operator approval gate before their tools become callable. Today (post-[Done/MCP-LOADING-LOCAL.md](Done/MCP-LOADING-LOCAL.md)) a customer drops a folder under `${MCP_DROPIN_DIR}/<name>/tools/` and the connector immediately exposes its tools to the controller via `manifest-delta`. There is no operator gesture between "folder appears on disk" and "LLM can call this tool." This plan adds that gesture.
>
> **Why this is a separate plan from MCP-LOADING-LOCAL.md.** That plan finished the *authoring* experience (drop a folder, no boilerplate). What it did NOT change is the **trust model**: customer drop-ins auto-enabled the moment the connector saw them, while 3rd-party (Type 2) MCPs require operator setup in the controller UI. This plan resolves that asymmetry — both paths now require an operator gesture in the controller before tools land in the manifest.
>
> **Branch.** `feature/mcp-custom-approval` (cut from `main`, do not push).
>
> **Status: drafting.** No code yet. This document is the contract for the controller team — once they've read it they can implement their side in parallel with the connector-side work.
>
> **Cross-tree pointer.** This plan is the connector-side specification. The controller-side counterpart lives at [`AgenticProcedure/.claude/plans/MCP-CUSTOM-APPROVAL.md`](../../../AgenticProcedure/.claude/plans/MCP-CUSTOM-APPROVAL.md) (or wherever the controller team chooses to track it). The wire-format additions in §"Wire protocol — v1.3 additions" below are inline so this document is self-contained — it does NOT depend on [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) being updated first. Protocol-doc edits land in W-A5 alongside the connector code.

## What this changes

### Today (post-MCP-LOADING-LOCAL)

```
[customer drops folder]
   → connector scans MCP_DROPIN_DIR
   → spawns child process
   → calls tools/list on the child
   → tools land in manifest
   → first manifest-delta sent to controller
   → operator sees them in the controller UI, fully wired
   → LLM can call them immediately
```

There is no point at which an operator says "yes, I want this MCP enabled." The customer admin's gate is the filesystem (whoever has write access to `MCP_DROPIN_DIR`).

### After this plan

```
[customer drops folder]
   → connector scans MCP_DROPIN_DIR
   → spawns child process                      (unchanged — keeps crash isolation)
   → calls tools/list on the child             (unchanged — connector knows the surface)
   → tools NOT in manifest yet                 (NEW — gated behind approval)
   → connector emits mcp-discovered frame      (NEW)
   → controller UI shows "Pending approval" entry in custom-MCPs section
   → operator clicks Approve, optionally pastes envKeys values
   → controller emits mcp-enable {mcp, env?}   (NEW)
   → connector applies env, adds tools to manifest, emits manifest-delta
   → controller emits mcp-enable-ack
   → LLM can call the tools
```

The child is running the whole time. Approval is a manifest-visibility gate, not a process-lifecycle gate — re-approval after revocation is instant.

## Decisions locked

| # | Question | Decision | Notes |
|---|---|---|---|
| **DA1** | Where does the gate live? | **Connector + new wire frames.** | Controller-only filtering was the cheaper alternative but doesn't enforce the gate at the trust boundary. The connector now physically withholds tools from the manifest until approval. |
| **DA2** | When does creds entry happen? | **As part of approval.** | One operator gesture: the approval form shows the envKeys list and lets the operator paste values inline. `mcp-enable` carries optional `env`. Late creds still work via the existing `creds-update` path. |
| **DA3** | Where does approval state live across connector restarts? | **Controller-only, replay on register-ack.** | Controller maintains the approved list. After register-ack it sends `mcp-enable` for every previously-approved MCP. No new connector-side persistence (`.connector-state.json` stays unchanged). |
| **DA4** | What does `mcp-discovered` carry about each tool? | **Names + descriptions, no schemas.** | Operator UI needs enough context to decide. Input/output schemas stay withheld until approval — they're the actual surface area. |
| **DA5** | What happens to the child when an MCP is disabled? | **Keep running, drop tools from manifest only.** | Cheap re-enable. No `stop` field on `mcp-disable` — the simpler protocol. If a future scenario needs hard-stop, add a separate `mcp-stop` frame; don't overload `mcp-disable`. |
| **DA6** | Twilio + customer drop-in name collision (e.g. customer authors a folder named `twilio`)? | **Don't handle it specially — document the precedence.** | Bundled entries are yaml-listed; the drop-in scanner already skips folders named in yaml. No new code needed; just a doc note. |
| **DA7** | What about yaml-listed Type 1 hand-written MCPs (the legacy escape hatch)? | **Auto-enabled, like Twilio bundle.** | Yaml listing is the existing acceptance gesture. The new gate is for `source: "local"` (drop-in) MCPs only. |
| **DA8** | What about 3rd-party (Type 2, controller-pushed) MCPs? | **Unchanged.** | Already operator-gated by definition (the operator authored them in the controller UI). The new gate doesn't apply. |

## Mental model

> "Two places an MCP becomes legitimate: yaml (bundled, shipped in the image) or controller approval (everything else). The drop-in folder is a *proposal*, not an *acceptance*."

## Wire protocol — v1.3 additions

Four new frame types. All inline-defined here; [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) gets edited in W-A5 once the connector code lands.

The frame envelope rule from v1.0 still holds: unknown frame types are ignored by both sides. An older controller (pre-v1.3) that doesn't know `mcp-discovered` will simply not surface customer drop-ins — the MCP stays in pending forever, the operator never sees it, the LLM never calls it. That's the correct fail-closed behavior; no fallback to auto-enable.

### `mcp-discovered` (connector → controller)

Sent when the connector spawns a customer drop-in MCP whose tools are NOT yet in the manifest. Two emission points:

1. **Boot.** After `register` is sent (so the controller has a `connectorId` to scope against), one frame per drop-in MCP that is NOT already in the controller's approved list (per the previous register's replay).
2. **Runtime rescan.** When [`LocalMcpsCoordinator.rescan()`](../../packages/connector/src/tunnel/local-mcps-coordinator.ts) discovers a new drop-in folder and spawns the child, one frame per added MCP.

The frame is fire-and-forget from the connector's perspective — the controller's reply is the eventual `mcp-enable` (or absence of one, indefinitely).

```ts
interface McpDiscoveredFrame {
  type: "mcp-discovered";
  mcp: string;                    // folder name; stable identity across reconnects
  author: "customer";             // always — bundled / yaml / 3rd-party MCPs don't go through this gate
  source: "local";                // always — same gate, different field for clarity vs status filters
  envKeys: string[];              // de-duped union from the child's /envkeys endpoint
  tools: Array<{
    name: string;                 // e.g. "issue_refund"
    description?: string;         // from the tool's register() metadata; absent if author omitted
  }>;
  discoveredAt: string;           // ISO8601, connector wall-clock
}
```

**JSON example:**

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
  "discoveredAt": "2026-06-22T18:33:21Z"
}
```

**What's deliberately NOT in the payload:**
- `inputSchema` / `outputSchema` — the actual call surface; withheld until approval.
- `prompts` / `resources` — for now only `tools` is gated; if customer drop-ins grow prompts/resources surfaces, extend the frame in v1.4.
- `mcpId` — the controller mints its own row id on first approval; the connector identifies by `mcp` (the folder name) end-to-end.

### `mcp-enable` (controller → connector)

Sent when the operator approves an MCP in the controller UI. Carries optional `env` if the operator pasted creds in the same gesture.

Two emission points:

1. **Operator approval.** New approval click in the controller UI.
2. **Replay on register-ack.** For every previously-approved MCP, the controller re-sends `mcp-enable` after `register-ack`. This is the source-of-truth-restore mechanism per **DA3**.

```ts
interface McpEnableFrame {
  type: "mcp-enable";
  mcp: string;
  env?: Record<string, string>;   // optional — pasted creds; subset of envKeys is fine
  source?: "operator-entered";    // for telemetry / inspector display; reserved for future values
}
```

**JSON example (initial approval with creds):**

```json
{
  "type": "mcp-enable",
  "mcp": "crm",
  "env": { "MOCK_CUSTOMERS_URL": "https://mock.internal:7400" },
  "source": "operator-entered"
}
```

**JSON example (re-replay on register-ack, no env change):**

```json
{ "type": "mcp-enable", "mcp": "crm" }
```

The connector treats both forms identically: idempotent enable. If `env` is present, it's merged via the existing `supervisor.applyControllerEnv(name, env, source, "mcp-enable")` path — same merge order as today (`process.env ⊕ spec.env ⊕ sessionEnv ⊕ controllerEnv`). If `env` is absent, the existing controllerEnv (if any from a prior `creds-update`) is preserved unchanged.

### `mcp-disable` (controller → connector)

Sent when the operator revokes approval in the controller UI.

```ts
interface McpDisableFrame {
  type: "mcp-disable";
  mcp: string;
}
```

Per **DA5**, no `stop` field. The connector keeps the child running — disable is a manifest-visibility toggle only. Re-enable via a fresh `mcp-enable` puts the tools back into the manifest with no spawn latency.

If a future scenario needs to actually kill the child (e.g. operator wants to free RAM, or the MCP is misbehaving), add a separate `mcp-stop` frame in a later version. Don't overload `mcp-disable` with a boolean — frames are cheap, semantics are not.

### `mcp-enable-ack` (connector → controller)

Sent in reply to every `mcp-enable` (success or error). Sent in reply to `mcp-disable` for symmetry — same frame type, `status: "disabled"`.

```ts
interface McpEnableAckFrame {
  type: "mcp-enable-ack";
  mcp: string;
  status: "enabled" | "disabled" | "error";
  error?: string;                 // present iff status === "error"
  toolsCount?: number;            // present iff status === "enabled"; reflects post-merge manifest
}
```

**Error cases:**

| Scenario | `status` | `error` |
|---|---|---|
| Controller sent `mcp-enable` for an unknown name | `"error"` | `"unknown_mcp"` |
| Connector failed to apply env (e.g. supervisor restart errored) | `"error"` | `"apply_env_failed: <reason>"` |
| MCP is yaml-listed (not a drop-in — gate doesn't apply) | `"error"` | `"not_gated: yaml-listed MCP, no approval needed"` |
| MCP is `controller-config` (3rd-party) — gate doesn't apply | `"error"` | `"not_gated: 3rd-party MCP, use mcp-config-snapshot"` |

**JSON example (success):**

```json
{ "type": "mcp-enable-ack", "mcp": "crm", "status": "enabled", "toolsCount": 3 }
```

**JSON example (error — controller approving something that isn't a drop-in):**

```json
{ "type": "mcp-enable-ack", "mcp": "twilio", "status": "error", "error": "not_gated: yaml-listed MCP, no approval needed" }
```

### Frame ordering rules

1. `mcp-discovered` MUST precede the first `manifest-delta` for that MCP. The connector withholds the MCP's tools from the manifest until `mcp-enable` arrives.
2. After `mcp-enable` succeeds, the connector emits `manifest-delta { added: [<the new server descriptor>] }` BEFORE `mcp-enable-ack`. The ack is the "I'm done" signal; the manifest-delta is the actual surface change.
3. After `mcp-disable`, the connector emits `manifest-delta { removed: [<server name>] }` BEFORE `mcp-enable-ack { status: "disabled" }`.
4. `mcp-enable` for an already-enabled MCP is idempotent — no manifest-delta (nothing changed), but the ack still fires with `status: "enabled"` and the current `toolsCount`. Useful for the register-ack replay path: controller doesn't have to track whether the connector remembers from last session.

### Backwards compatibility

| Connector v1.3 + Controller v1.2 | Controller doesn't know `mcp-discovered`. The frame is dropped. The MCP stays pending forever — no manifest exposure. **Fail-closed** by design. |
| Connector v1.2 + Controller v1.3 | Connector doesn't withhold tools from manifest — drop-ins auto-enable as today. Controller sees them in `manifest-delta` without prior `mcp-discovered`. Controller MUST treat any `manifest-delta` containing an unknown customer-authored MCP as implicitly approved (legacy behavior). On the next deploy of the v1.3 connector, the gate engages. |

The asymmetry favors the migration: a fresh connector against an old controller is the conservative path; a fresh controller against an old connector preserves today's behavior. Standard ship order is connector-first, controller catches up — same as v1.2 (`local-mcps-rescan`).

## Sequences (full timing)

The sequences below cover every path the controller team needs to handle. Each diagram is wall-clock-ordered, top-to-bottom; arrows show frame direction.

### Sequence 1 — First-ever boot, fresh customer drop-in

The connector boots for the first time after a customer dropped a folder under `${MCP_DROPIN_DIR}/crm/tools/`. The controller has never seen this MCP before — no approval row exists.

```
[Connector startup]
  scan MCP_DROPIN_DIR  →  finds crm/
  spawn child via dropin-runner   (child running, tools loaded into McpServer)
  HTTP GET child:/envkeys         →  ["MOCK_CUSTOMERS_URL"]
  list child tools/list           →  [get_customer, get_recent, issue_refund]
  build manifest                  (crm tools WITHHELD — author=customer, source=local, not approved)

[Connector → Controller]   register { manifest: { servers: [...], excluding crm } }
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

[Controller UI]            renders crm in "Pending approval" lane of custom-MCPs section
                           operator clicks Approve, pastes MOCK_CUSTOMERS_URL value

[Controller → Connector]   mcp-enable {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" },
                              source: "operator-entered"
                            }

[Connector]                applyControllerEnv("crm", env, "operator-entered", "mcp-enable")
                              → supervisor restarts child (creds change requires restart for env to take effect)
                              → child re-registers tools at boot
                              → connector adds crm to approved set
                              → rebuilds manifest with crm tools included

[Connector → Controller]   manifest-delta { added: [{ name: "crm", tools: [3 tools with full schemas], envKeys: [...] }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }

[LLM]                      can now call crm.issue_refund (and the other two)
```

**Latency budget.** From `register-ack` to `mcp-enable-ack` is operator-bound (could be seconds, could be days). The connector spawns the child unconditionally before `register` so there's no spawn cost when approval finally arrives — just an env-driven restart, which is cheap.

### Sequence 2 — Reconnect with previously-approved MCP (replay path)

The same connector restarts (image redeploy, container restart, WS reconnect after network blip — any path that triggers a fresh `register`). The controller already has `crm` marked approved with persisted env from Sequence 1.

```
[Connector startup]                       (or WS reconnect after drop)
  scan, spawn, list tools                 (same as Sequence 1)
  build manifest                          (crm WITHHELD — connector has no approval state across restart)

[Connector → Controller]   register { manifest: { servers: [...], excluding crm } }
[Controller → Connector]   register-ack { connectorId: "conn_abc" }

[Connector → Controller]   mcp-discovered { mcp: "crm", ... }

[Controller]               looks up crm in approved table for connectorId="conn_abc"
                           found — replay enable with persisted env

[Controller → Connector]   mcp-enable {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" }
                            }

[Connector]                same as Sequence 1 — applyControllerEnv → restart → manifest add

[Connector → Controller]   manifest-delta { added: [{ name: "crm", ... }] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "enabled", toolsCount: 3 }
```

**Why the connector emits `mcp-discovered` even for previously-approved MCPs.** The connector is stateless across restarts (per **DA3**) — it doesn't know which MCPs the controller has approved until the controller tells it. The connector treats every drop-in as "potentially pending" and lets the controller's approval table decide. This avoids splitting state-of-truth between connector and controller.

The controller-side handling rule: **on every `mcp-discovered`, look up `(connectorId, mcp)` in the approval table; if found, emit `mcp-enable` immediately (with stored env if any).** No operator gesture required for replay.

**Why no lookup-by-mcpId.** The controller may have its own row id for the approved MCP, but the wire identity is `(connectorId, mcp-name)` — the folder name on the connector's disk. Same key as `creds-update` today.

### Sequence 3 — Operator revokes approval

The operator clicks Disable in the controller UI. The child stays running; only manifest visibility flips off.

```
[Controller UI]            operator clicks Disable for crm

[Controller → Connector]   mcp-disable { mcp: "crm" }

[Connector]                supervisor.markUnapproved("crm")
                              → child KEEPS running (no stopAll, no restart)
                              → manifest rebuilt without crm's tools

[Connector → Controller]   manifest-delta { removed: ["crm"] }
[Connector → Controller]   mcp-enable-ack { mcp: "crm", status: "disabled" }

[LLM]                      crm.issue_refund returns "tool not found" via the controller's normal dispatch
```

**Re-enable after disable** is a fresh `mcp-enable` from the controller. The connector marks the MCP approved again, rebuilds the manifest, emits `manifest-delta { added: [...] }` and `mcp-enable-ack { status: "enabled" }`. No spawn — the child has been running the whole time. Sub-second turnaround.

### Sequence 4 — Runtime drop-in (W-L2 rescan path)

The connector is already running, fully connected. The customer drops a new folder `mcp/local/inventory/tools/` and either clicks the inspector's loopback rescan button or an operator clicks **Refresh local MCPs** in the controller UI.

```
[Trigger]                  EITHER inspector POST /mcp/rescan-local
                           OR     [Controller → Connector] local-mcps-rescan {}

[Connector]                LocalMcpsCoordinator.rescan()
                              → discoverDropins({yamlNames})
                              → diff vs supervisor.statusList() filtered to source==="local"
                              → ADDED: inventory
                              → supervisor.registerOne(spec, {source: "local"})
                              → supervisor.startOne("inventory")  (child spawns)
                              → fetchEnvKeys("inventory")          (HTTP probe)

[Connector → Controller]   mcp-discovered {
                              mcp: "inventory",
                              author: "customer",
                              source: "local",
                              envKeys: [...],
                              tools: [...],
                              discoveredAt: "2026-06-23T12:34:56Z"
                            }
[Connector → Controller]   local-mcps-rescan-ack {
                              added:     [{name: "inventory", toolsCount: 2}],
                              removed:   [],
                              unchanged: ["sample", "crm"],
                              errors:    []
                            }

[Controller UI]            "Done — 1 added" toast + inventory in pending lane

[... operator approval flow continues like Sequence 1 ...]
```

**Difference from Sequence 1**: `mcp-discovered` is interleaved with `local-mcps-rescan-ack`. Both are independent — the controller's approval flow doesn't block on the rescan ack, and the rescan ack doesn't carry approval state.

The rescan-added MCP **does NOT auto-fire `creds-request` like today's [`onMcpAdded`](../../packages/connector/src/tunnel/local-mcps-coordinator.ts) hook does.** The new approval gate REPLACES that path for customer drop-ins — `mcp-discovered` carries the envKeys list, and the operator enters them as part of approval. The `creds-request` flow stays in place for yaml-listed Type 1 hand-written MCPs and Type 3 bundled MCPs (Twilio).

### Sequence 5 — Rescan removes a folder

Operator deleted `mcp/local/inventory/` from disk and triggered a rescan.

```
[Trigger]                  same as Sequence 4

[Connector]                LocalMcpsCoordinator.rescan()
                              → diff: REMOVED: inventory
                              → supervisor.unregister("inventory")  (child SIGTERM'd)

[Connector → Controller]   manifest-delta { removed: ["inventory"] }   (only if inventory was approved)
[Connector → Controller]   local-mcps-rescan-ack {
                              added:     [],
                              removed:   ["inventory"],
                              unchanged: ["sample", "crm"],
                              errors:    []
                            }
```

**Note:** the controller may still have an approval row for the deleted MCP. That's fine — it stays in the table marked approved-but-orphaned. If the customer later drops a folder with the same name, the next `mcp-discovered` will trigger the replay path (Sequence 2) and the approval auto-applies. If the controller wants to garbage-collect orphaned rows, that's a controller-side decision out of scope here.

### Sequence 6 — Late creds update (existing path, unchanged)

Operator updates `MOCK_CUSTOMERS_URL` for a previously-approved MCP. This goes through the existing `creds-update` frame, NOT through `mcp-enable`.

```
[Controller → Connector]   creds-update {
                              mcp: "crm",
                              env: { MOCK_CUSTOMERS_URL: "https://mock-v2.internal:7400" },
                              source: "operator-entered"
                            }

[Connector]                applyControllerEnv → restart child → manifest stays same shape
                           (tool list didn't change, so manifest-delta omitted)
```

**`mcp-enable` is for the approval gesture; `creds-update` is for ongoing creds management.** They're independent paths post-approval — same as today.

### Sequence 7 — Operator approves an unknown MCP (race / bug)

The controller sent `mcp-enable` for a name the connector doesn't know. Could happen if the customer deleted the folder between `mcp-discovered` and `mcp-enable`, or if the controller's approval table got out of sync.

```
[Controller → Connector]   mcp-enable { mcp: "ghost" }

[Connector]                supervisor.statusList().find(s => s.name === "ghost") → undefined
                           no manifest change, no env apply

[Connector → Controller]   mcp-enable-ack { mcp: "ghost", status: "error", error: "unknown_mcp" }
```

**Controller recovery**: log the error, mark the approval row as orphaned (matches Sequence 5's deleted-folder case). Do NOT retry — the next `mcp-discovered` (if the folder reappears) is the natural recovery point.

## Stages

Five stages. W-A1 → W-A5 in ship order. Each stage independently shippable; the gate isn't load-bearing until W-A4 (manifest withholding). Stages 1–3 land plumbing without behavior change; W-A4 flips the switch; W-A5 is docs.

### W-A1 — Wire frames + protocol doc

**Files:**
- [`packages/connector/src/tunnel/frames.ts`](../../packages/connector/src/tunnel/frames.ts) — add `McpDiscoveredFrame`, `McpEnableFrame`, `McpDisableFrame`, `McpEnableAckFrame` to the discriminated union. Update the `parseFrame` zod schema.
- `tests/tunnel/frames.test.ts` — add round-trip parse tests for each new frame type. Pin the unknown-fields-tolerated rule (controller may add fields in v1.4 without breaking us).
- [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) — new "v1.3 — Customer drop-in approval gate" stanza after the v1.2 stanza. Bump the version line. Inline copy of the frame schemas from this plan's "Wire protocol — v1.3 additions" section.

**No behavior change.** The frames exist on the wire; the connector doesn't emit them yet (W-A2). The controller can implement against the doc in parallel.

### W-A2 — Approval coordinator

**Files:**
- **NEW** `packages/connector/src/tunnel/approval-coordinator.ts` — analogous to [`mcp-config-coordinator.ts`](../../packages/connector/src/tunnel/mcp-config-coordinator.ts). Owns the in-memory approved-set (`Set<string>` of mcp folder names). Handles inbound `mcp-enable` / `mcp-disable`. Emits `mcp-discovered` for drop-ins not yet in the approved set. Emits `mcp-enable-ack` after applying.
- **LIFETIME**: same shape as `McpConfigCoordinator` and `LocalMcpsCoordinator`. Constructed ONCE per connector process (in `boot/lifecycle.ts`). Per-tunnel rebind via `bind({send})` swaps the wire callback only — the approved-set survives WS reconnect by design (controller replays `mcp-enable` after each `register-ack`, but the connector's in-memory set is the runtime gate; clearing it on reconnect would create a flicker where tools vanish from the manifest until the replay completes).
- **Public API** (consumed by boot wiring):
  ```ts
  isApproved(mcp: string): boolean
  emitDiscovered(spec: SupervisedSpec): void   // called after registerOne+startOne for drop-ins
  bind(b: { send: (frame) => void; log?: Logger }): void
  ```
- `tests/tunnel/approval-coordinator.test.ts` — defensive tests pinning: enable applies env via supervisor, disable preserves child, ack ordering (manifest-delta before ack), unknown_mcp error path, idempotent re-enable.

**Still no behavior change visible to the operator.** The coordinator exists, accepts frames, fires acks; manifest still includes all drop-ins (W-A4 flips that).

### W-A3 — Manifest gate

**Files:**
- [`packages/connector/src/manifest/build.ts`](../../packages/connector/src/manifest/build.ts) — `buildManifest` accepts a new optional param `isApproved?: (name: string) => boolean`. For each server descriptor, if `author === "customer"` AND `source === "local"` AND `!isApproved(name)`, omit the descriptor entirely (NOT just the tools — the whole entry, so the controller doesn't see a partial). Yaml + bundled + 3rd-party entries are unaffected.
- `tests/manifest/build.test.ts` — add test cases pinning: drop-in NOT approved is omitted; drop-in approved is included; yaml-listed never gated regardless of `isApproved`.

**Still no behavior change at runtime** because [`boot/lifecycle.ts`](../../packages/connector/src/boot/lifecycle.ts) doesn't pass the `isApproved` callback yet. W-A4 wires it in.

### W-A4 — Boot wiring (the flip)

**Files:**
- [`packages/connector/src/boot/lifecycle.ts`](../../packages/connector/src/boot/lifecycle.ts) — instantiate `ApprovalCoordinator`. Pass `coord.isApproved.bind(coord)` to every `buildManifest` call. After `register` is sent and `register-ack` arrives, fire `coord.emitDiscovered(spec)` for every drop-in spec not already approved. Wire the frame router branch for `mcp-enable` / `mcp-disable` to `coord.handle*`. On `mcp-enable` success, the supervisor's existing `onRestart` callback (already pushes manifest-delta) covers the manifest update.
- [`packages/connector/src/tunnel/local-mcps-coordinator.ts`](../../packages/connector/src/tunnel/local-mcps-coordinator.ts) — change `onMcpAdded` for customer drop-ins: call `approvalCoord.emitDiscovered(spec)` instead of `creds.reload(...)`. Yaml-listed Type 1 drop-ins (the legacy escape hatch) stay on the `creds.reload(...)` path. **Routing key**: `spec.__dropin === true` → approval gate; otherwise → creds-request.
- [`packages/connector/src/inspector/`](../../packages/connector/src/inspector/) — new badge state `pending` (orange, alongside `local`/`yaml`/`controller-config`). Pending MCPs render in the MCP Server panel but their tools panel reads "awaiting approval — N tools pending" instead of the usual call-tool buttons. **Trust boundary**: the inspector's `toolDispatch` filter must reject calls to unapproved MCP tools too — otherwise the inspector becomes a backdoor around the gate.
- `tests/boot/approval-flow.test.ts` — end-to-end pin: discover folder → manifest excludes it → enable arrives → manifest-delta adds it → disable arrives → manifest-delta removes it → re-enable adds it back without spawn.

**This is the behavior-flip stage.** After W-A4 lands, drop-ins require approval. Test suite must be green before merging.

### W-A5 — Docs sweep + plan move

**Files:**
- [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) — add "After dropping the folder" section explaining the approval step. Operator goes to controller UI → connector detail → custom-MCPs section → click Approve, paste creds.
- [`packages/connector/README.md`](../../packages/connector/README.md) — "Author a local MCP (drop-in)" section gets the same approval-step paragraph.
- [`CLAUDE.md`](../../CLAUDE.md) — three updates:
  1. "Three MCP integration patterns" — Type 1 drop-in description gets the approval-gate paragraph.
  2. "Architecturally load-bearing properties" — new bullet: "Customer drop-in MCPs are gated by controller approval. The drop-in folder is a proposal; tools are withheld from the manifest until `mcp-enable` arrives." Cross-link to this plan.
  3. "Wire protocol — frames" — add the four new v1.3 frames to the bullet list.
- Plan move: this file → `.claude/plans/Done/MCP-CUSTOM-APPROVAL.md` once W-A1..W-A4 are merged AND verified live.
- Test catalog: append rows to [`.claude/plans/TEST-SUITE.md`](TEST-SUITE.md) for the new tests added in W-A1..W-A4.

### Stages table

| Stage | Workstream | Delivers | Status |
|---|---|---|---|
| **W-A1** | wire | Frame types + protocol doc; controller can implement against it. | not started |
| **W-A2** | runtime | ApprovalCoordinator with full inbound/outbound frame handling; not yet wired into boot. | not started |
| **W-A3** | manifest | `buildManifest` gains optional `isApproved` predicate; gating logic exists but not invoked. | not started |
| **W-A4** | flip | Boot wiring connects coordinator + manifest gate + inspector. **Behavior change ships here.** | not started |
| **W-A5** | docs | AUTHOR-LOCAL-MCP, README, CLAUDE.md updates; plan moves to Done. | not started |

**Suggested ship order (locked):** W-A1 → W-A2 → W-A3 → W-A4 → W-A5. W-A1..W-A3 can be split across small PRs; W-A4 is the merge gate where the gate goes live and needs full smoke testing.

### Verification per stage

- **W-A1**: `npm run build` clean; `npm test` passes the new frame-parse tests; `docs/MCP-PROTOCOL.md` renders cleanly in the IDE preview.
- **W-A2**: Coordinator unit tests pass. Manual smoke: hand-craft a `mcp-enable` frame in the inspector's "Frames" panel injection (if the inspector supports that today; otherwise add a test-only inspector route gated on `process.env.NODE_ENV !== "production"`). Confirm the supervisor restart fires.
- **W-A3**: Manifest tests pin both branches (approved / not approved) per server descriptor. Boot is unchanged because `isApproved` isn't passed yet.
- **W-A4**: End-to-end live boot. Boot the connector with `mcp/local/sample/` and `mcp/local/crm/` present. Confirm:
  - Initial manifest sent on `register` excludes both.
  - Two `mcp-discovered` frames fire after `register-ack`.
  - Controller (mock or real) replies with `mcp-enable` for both.
  - Manifest-delta adds both with full tool descriptors.
  - LLM call to `crm.issue_refund` succeeds.
  - Click Disable in controller → manifest-delta removes; LLM call now fails with "tool not found"; child still alive (verify via `ps` or inspector status panel).
  - Click Re-enable → manifest-delta re-adds; LLM call succeeds again with no spawn delay.
- **W-A5**: Customer-doc smoke: a new engineer reading [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) cold can drop a folder, approve it in the controller UI, and call a tool — without asking anyone questions.

### Outstanding work for the merge-to-main pass

- [ ] Update [`.claude/plans/TEST-SUITE.md`](TEST-SUITE.md) catalog rows for each new test file.
- [ ] Cut a tracking entry in [`AgenticProcedure/.claude/plans/`](../../../AgenticProcedure/.claude/plans/) for the controller-side counterpart so the controller team has a sibling plan that links back here.
- [ ] Verify live-boot smoke test (W-A4 verification list above) before declaring the merge done.
- [ ] Decide whether to flip `[Pending] / [Approved]` badges to copy that matches the controller team's chosen UI strings (might be `[Awaiting approval] / [Live]` etc. — sync with controller team in W-A5).

## Architectural properties this plan preserves

- **Outbound-only invariant.** Approval flow is controller → connector via the existing WS. No new inbound port; no new public surface area on the connector. Inspector loopback path is unchanged.
- **Per-MCP env isolation.** The four-layer merge order (`process.env ⊕ spec.env ⊕ sessionEnv ⊕ controllerEnv`) is unchanged. `mcp-enable` writes into the same `controllerEnv` map used by `creds-update` today; cross-MCP env leakage stays impossible.
- **Crash isolation.** Children spawn unconditionally (before approval). A misbehaving customer tool still can't crash the connector — same per-folder subprocess boundary the supervisor enforces today. Approval is a *manifest-visibility* gate, not a *spawn-or-not* gate.
- **Controller-as-source-of-truth for trust decisions.** Today: the customer admin's gate is the filesystem (`MCP_DROPIN_DIR` write access). After this plan: the operator's gate is in the controller UI. Both gates are still required — disk access is the *proposal*, controller approval is the *acceptance*. Two-key model.
- **Stateless connector across restarts.** No new persistence in `.connector-state.json`. The approved set is rebuilt every register cycle from the controller's replay. Same posture as today's 3rd-party MCP roster (in-memory, rebuilt from `mcp-config-snapshot`).

## Test-suite hooks

Cross-refs into [`.claude/plans/TEST-SUITE.md`](TEST-SUITE.md). Add catalog rows when each test lands:

- **W-A1**: `frames.test.ts` — round-trip parse for each new frame type. Pin the unknown-fields-tolerated rule for forward compat.
- **W-A2 — coordinator unit tests** at `tests/tunnel/approval-coordinator.test.ts`:
  - `mcp-enable` for a known drop-in applies env via supervisor, marks approved, emits ack with `toolsCount`.
  - `mcp-enable` with no `env` field is idempotent (preserves prior controllerEnv).
  - `mcp-disable` marks unapproved, child stays running (verify via `supervisor.statusList()` process state), emits ack with `status: "disabled"`.
  - `mcp-enable` for an unknown name emits ack with `status: "error"`, `error: "unknown_mcp"`.
  - `mcp-enable` for a yaml-listed MCP emits ack with `status: "error"`, `error: "not_gated: ..."`.
  - Re-enable after disable: no spawn (process state unchanged), manifest-delta added, ack `status: "enabled"`.
  - `bind({send})` swaps the wire callback without resetting the approved set.
- **W-A3 — manifest gate tests** at `tests/manifest/build.test.ts`:
  - Drop-in MCP with `isApproved("name") === false` is omitted from `manifest.servers` entirely (not partially included).
  - Drop-in MCP with `isApproved("name") === true` is included with full tool descriptors.
  - Yaml-listed MCP is included regardless of `isApproved` return.
  - 3rd-party `controller-config` MCP is included regardless of `isApproved` return.
  - Without `isApproved` callback, every MCP is included (preserves pre-W-A4 behavior for the W-A3 ship window).
- **W-A4 — boot end-to-end** at `tests/boot/approval-flow.test.ts`:
  - First boot: drop-in spawned, manifest excludes it, `mcp-discovered` fires, controller-side mock replies `mcp-enable`, manifest-delta adds, ack fires.
  - Reconnect: manifest excludes again, `mcp-discovered` fires again, replay `mcp-enable` arrives, manifest-delta re-adds.
  - Disable: manifest-delta removes, child still running (verify process map), ack `status: "disabled"`.
  - Re-enable post-disable: manifest-delta re-adds without spawn (verify `restartCount` unchanged).
  - Inspector `toolDispatch` rejects calls to unapproved MCPs (trust-boundary regression pin).

## Risks and concerns

- **Operator workflow friction.** Every new customer drop-in now requires an explicit approval click. For dev-iteration scenarios where the customer-author IS the controller-operator (common in early adoption), this is two extra clicks per folder. Mitigations:
  - The inspector's loopback rescan path could surface a "self-approve from inspector" affordance, gated on a dev-mode env flag. Not in scope for v1.3 — flag for v1.4 if real friction emerges.
  - Document the workflow upfront in [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) so customers know what to expect.
- **Controller-side approval table is now load-bearing.** If the controller's DB is restored from a stale backup, previously-approved MCPs become pending again — operator has to re-approve. This is acceptable (it's a security-positive failure mode), but should be documented in the controller team's ops runbook.
- **Race between rescan removal and `mcp-enable`.** Operator approves an MCP at the same instant the connector rescans and the folder is gone. Controller's `mcp-enable` lands → connector replies `unknown_mcp`. Operator UX shows a transient error. Mitigation: controller should ack-reconcile on `mcp-enable-ack { status: "error" }` and retry the lookup once after a short delay before showing an operator error. Documented in Sequence 7 above.
- **Frame storms on reconnect with many pending MCPs.** A connector with 20 unapproved drop-ins emits 20 `mcp-discovered` frames after `register-ack`. The 256 KB per-frame cap from the existing tunnel rules covers this trivially (each frame is ~1 KB), but the controller's UI might thrash if it re-renders per-frame. Controller-side concern; flag it for the controller team to batch UI updates.

## Future work flagged for later

- **`mcp-stop` frame** for actually killing the child without uninstalling the MCP. Out of scope for v1.3 per **DA5**. Pull forward when an operator scenario emerges (e.g. RAM pressure, MCP misbehavior that needs a hard reset).
- **Approval scopes / RBAC.** Today every operator with controller access can approve. No granularity for "this operator can approve customer MCPs but not 3rd-party MCPs," etc. Controller-side concern; out of scope.
- **Approval audit log.** Who approved what, when. Controller-side persistence; not on the wire. Recommend the controller team capture the operator identity from session and stamp the approval row.
- **Per-tool gating revival.** The `ToolDescriptor.allowed` field on the wire is still hardcoded `true`. If a future enterprise-strict customer wants per-tool approval, the gate already exists at the descriptor level — adding `mcp-enable-tools { mcp, tools: string[] }` would be a clean v1.4 extension.
- **Scoped envKeys responses.** Today `mcp-enable.env` is a flat map. If approval forms grow conditional logic (e.g. "if mode is X, also need keys A/B"), consider extending the envKeys hint shape per MCP-CLIENT-USE conventions. Not urgent; flag if needed.

## Cross-references

- [Done/MCP-LOADING-LOCAL.md](Done/MCP-LOADING-LOCAL.md) — predecessor plan. Established the drop-in scanner, runtime rescan, and `local` source badge that this plan builds on. The "What this plan is NOT changing" section there enumerates invariants this plan also preserves.
- [Done/MCP-LOADING.md](Done/MCP-LOADING.md) — grandparent plan. Established the supervisor, dropin-runner, creds protocol, 3rd-party MCP roster. Frame-router pattern and coordinator lifetime conventions come from there.
- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire-format authority. W-A5 adds the v1.3 stanza; until then the wire-format spec in §"Wire protocol — v1.3 additions" above is the contract for the controller team.
- [packages/connector/src/tunnel/mcp-config-coordinator.ts](../../packages/connector/src/tunnel/mcp-config-coordinator.ts) — pattern reference for `approval-coordinator.ts`. Same lifetime contract (constructed once per process, rebound per tunnel via `bind()`), same single-flight discipline.
- [packages/connector/src/tunnel/local-mcps-coordinator.ts](../../packages/connector/src/tunnel/local-mcps-coordinator.ts) — needs a small change in W-A4 to route drop-ins (`__dropin === true`) through the approval coordinator instead of `creds.reload()`.
- [packages/connector/src/manifest/build.ts](../../packages/connector/src/manifest/build.ts) — gate is added here in W-A3. Today's `validateManifestSchemas` advisory pass stays unchanged.
- [packages/connector/src/mcp-supervisor.ts](../../packages/connector/src/mcp-supervisor.ts) — exposes `applyControllerEnv` already; W-A2 reuses it. No new supervisor methods needed.
- [packages/connector/src/inspector/server.ts](../../packages/connector/src/inspector/server.ts) — `toolDispatch` filter added in W-A4. Trust-boundary regression pin.
- [CLAUDE.md](../../CLAUDE.md) — "Three MCP integration patterns" + "Architecturally load-bearing properties" + "Wire protocol — frames" all need updates in W-A5 to reflect the gate.

## Quickstart — fresh-context resume after /clear

You are resuming from a cleared context. Here is everything you need to start work.

**Where you are:**
- This file is at `.claude/plans/MCP-CUSTOM-APPROVAL.md`. Branch is `feature/mcp-custom-approval` (cut from `main`, do not push).
- Standing rule from CLAUDE.md memory: **branch is local-only, do not push to origin**. Only `main` belongs there.

**What this plan is.** Add an operator-approval gate for customer-authored drop-in MCPs. Today they auto-enable when the connector finds the folder; after this plan they're held back until the controller sends `mcp-enable`. Four new wire frames; one new coordinator; one manifest filter; one inspector trust-boundary fix.

**What you should do FIRST, before reading further:**

1. Run `git status` to confirm you're on `feature/mcp-custom-approval` and the worktree is clean.
2. Read [Done/MCP-LOADING-LOCAL.md](Done/MCP-LOADING-LOCAL.md) end-to-end. Know the drop-in scanner, the LocalMcpsCoordinator pattern, and the source-badge plumbing.
3. Read [Done/MCP-LOADING.md](Done/MCP-LOADING.md) for the supervisor / creds / 3rd-party-roster primitives this plan builds on.
4. Read [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"v1.1" and §"v1.2" stanzas for wire-format conventions.
5. Read [CLAUDE.md](../../CLAUDE.md) for architectural invariants (outbound-only, per-MCP env isolation, inspector loopback-only). Don't violate these.
6. Read this plan's "Stages" table. Pick the first `not started` stage in ship order. Mark it `in_progress` in the table when you start; flip to `done — <SHA>` when committed.

**Suggested ship order (locked):** W-A1 → W-A2 → W-A3 → W-A4 → W-A5.

**Decisions that are already locked** (DA1–DA8, recap):
- DA1: Gate at the trust boundary (connector + new wire frames), not controller-only filtering.
- DA2: Creds entered as part of approval (one operator gesture).
- DA3: Controller-only approval state; replay `mcp-enable` on every register-ack.
- DA4: `mcp-discovered` carries names + descriptions; schemas withheld until approval.
- DA5: Disable is manifest-visibility-only; child keeps running.
- DA6: Twilio + customer drop-in name collision handled by existing yaml-listing rule.
- DA7: Yaml-listed Type 1 hand-written MCPs are NOT gated (yaml is the existing acceptance).
- DA8: 3rd-party (Type 2) MCPs are NOT gated (already operator-authored via controller UI).

If a decision needs revisiting based on what you find, surface it before coding — don't silently change direction.

**Standing rules to apply:**
- Pre-merge (specifically before W-A5): update [`CLAUDE.md`](../../CLAUDE.md) + relevant [`packages/connector/README.md`](../../packages/connector/README.md) + [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) based on what shipped.
- Tests: regression-driven. Add a [`TEST-SUITE.md`](TEST-SUITE.md) catalog row when manual scenarios surface real bugs, not for coverage. Use TS path aliases (`@mcp` / `@connector`) up front in any new test files — never deep `../` chains.
- Long Edit/Write payloads: chunk them across multiple calls; single Write trips the 8192-token output ceiling.
- Branch: stays on `feature/mcp-custom-approval`, local only. Don't push.
- Plan upkeep: when a stage finishes, mark its row `done — <commit SHA>` in the Stages table above. When the entire plan is complete, move this file to `.claude/plans/Done/MCP-CUSTOM-APPROVAL.md`.

**Cross-tree note.** The controller side (`AgenticProcedure/`) needs matching changes — a custom-MCPs section UI in the connector detail view that surfaces pending entries from `mcp-discovered` and emits `mcp-enable` / `mcp-disable`. That work is OUT OF SCOPE for this branch. Track it in [`AgenticProcedure/.claude/plans/`](../../../AgenticProcedure/.claude/plans/) with a pointer back to this plan.

