# MULTI-ACCOUNT — one connector, many controllers

> **Status:** planning only, **2026-07-08**. No branch yet. Architecture doc, not implementation. Coding intentionally deferred — we will code once the shape and open questions are settled.
>
> **Resolutions log — 2026-07-08.** Three open questions closed in the first review pass:
> - **Q1 (master-key source):** default to `file` (Docker/K8s Secret mount); `passphrase-kdf` retained for portable / dev use. `os-keychain` dropped.
> - **Q3 (name collision):** private-vs-shared name collision is rejected at push time via `mcp-config-ack { perMcp: [{status: "skipped", error: "name_collides_with_shared"}] }`. Shadowing removed. Private-vs-private across controllers stays allowed (different scopes, mutual invisibility preserved).
> - **Q4 (shared MCP creds authority):** the DB stores **tunnel creds only** (bearer / OAuth secret / registration token). Shared MCP per-runtime env stays in `dir/.env` on the connector filesystem — same as today. No `shared_mcp_creds` table, no "paste shared MCP creds" inspector flow, no `sharedCreds` env layer. Session-creds (loopback, in-memory, 12h TTL) still work for dev/debugging.
>
> **Resolutions log — 2026-07-09.** Second review pass, three more refinements:
> - **Q2 (DB engine) → Postgres.** Reuse the Postgres instance already spun up for llamaIndex / enterprise-knowledge. Adds a boot-dependency ordering (Postgres up → connector boots), gains free concurrent-writer semantics and standard migration tooling. Master-key sealing (libsodium) stays app-side; the DB stores ciphertext in `BYTEA`. SQLite path abandoned.
> - **Q3-refinement (global uniqueness + descriptive error).** Name-collision rule tightens: name must be **globally unique on this connector**, not just against shared. Collision with another controller's private roster is now also rejected (previously allowed under a "different scopes, mutually invisible" argument). Error payload expands: `{ status: "skipped", error: "name_taken", takenBy: "shared" | "other-controller" | "your-roster", existingName, ownerHint? }`. See §"Wire protocol changes."
> - **Q6 (per-controller approval semantics).** Confirmed: one shared child process runs regardless of approval; approval is a manifest-visibility gate, not a lifecycle gate. Controller-1-approves-only means only Controller 1 can enumerate and call the drop-in's tools; Controller 2 sees `-32601` (indistinguishable from unknown method) and cannot detect the MCP's existence on the connector.
>
> **Resolutions log — 2026-07-09 (later).** Third review pass, four more refinements:
> - **Q3-refinement-2 (owner hint on collision).** `ownerHint` field added to the collision ack payload — an operator-set label (e.g. `"twilio-prod-AC1234abc"`) stored in the `controllers.owner_hint` column. Weakens strict cross-controller opacity, but justified: **all controllers on one connector serve the same customer**, so identifying which of the customer's own controllers owns a name isn't a real leak. The strict N1 opacity was over-engineered for a same-tenant model.
> - **Q7-refinement (webhook body carries AccountSid).** For shared MCPs, one webhook allocation (first-controller-wins) is enough — the connector forwards the full callback body to the MCP, and Twilio-style callbacks already embed `AccountSid`. MCP author handles multi-account dispatch internally by inspecting `body.AccountSid`. No wire-protocol change.
> - **Q10 (legacy `.env` import → dropped).** No auto-import path. Customers set up controllers exclusively via the inspector. `TUNNEL_AUTH_TOKEN` / `CONTROLLER_URL` / `CONNECTOR_NAME` are removed from `.env` entirely.
> - **Q11 (CONTROLLER_URL / CONNECTOR_NAME → inspector too).** These are per-controller values, so they belong in the DB row alongside the bearer. `.env` retains only global connector config: `LOG_LEVEL`, `INSPECTOR_PORT`, `MCP_BASE_PORT`, `POSTGRES_URL`, `POSTGRES_SCHEMA`, `MCP_DROPIN_DIR`, `CONNECTOR_KEY_FILE`.
>
> **Purpose.** Extend the connector so that a single customer-side process can service **N controllers simultaneously**, each over its own outbound WSS tunnel with its own credentials, its own manifest view, and its own private set of Type 2 (controller-pushed) MCPs — while **Type 1 (local drop-ins) and Type 3 (bundled) MCPs remain shared across every controller** the connector is registered with.
>
> **Self-describing.** A fresh-context Claude reads this file + `CLAUDE.md` + [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) + [.claude/plans/CREDS-ENCRYPTION.md](CREDS-ENCRYPTION.md) + [.claude/plans/IDENTITY-RESOLUTION.md](IDENTITY-RESOLUTION.md) and can reason about the design without further context.
>
> **Companion docs.**
> - [`CREDS-ENCRYPTION.md`](CREDS-ENCRYPTION.md) — sealed-box wire encryption of env values. Multi-account inherits this per-controller (each controller seals with the same public key the connector minted at boot; keys are per **process**, not per **tunnel**).
> - [`CONTROLLER-HANDOFF-MCP-APPROVAL.md`](CONTROLLER-HANDOFF-MCP-APPROVAL.md) — the v1.3 drop-in approval gate. Multi-account extends the approval predicate to `(controller_id, mcp_name)` rather than global.
> - [`DEPLOY-ARCHITECTURE.md`](DEPLOY-ARCHITECTURE.md) — per-cloud runtime shapes. Multi-account is orthogonal: still one process per container, N tunnels inside it.

## TL;DR

Today: **one connector process ⇔ one WS tunnel ⇔ one controller.** Config lives in `./.env` + `./connector.yaml` + `./.connector-state.json`.

Target: **one connector process ⇔ N WS tunnels ⇔ N controllers.** Config lives in a Postgres schema (reusing the instance already deployed for the `enterprise-knowledge` bundle), with app-side field-level encryption of credential material. Each controller row is added, rotated, and removed via the inspector UI (localhost-only). The `.env` file survives as a bootstrap/migration surface only.

The MCP tree splits along two axes:

| MCP kind | Location | Visibility | Creds source | Approval gate |
|---|---|---|---|---|
| **Type 1 (local drop-in)** | `mcp/local/<name>/tools/*.ts` | Shared — every controller sees it in its manifest **after that controller approves it** | `dir/.env` (customer-managed on disk) + optional session-creds (loopback, ephemeral) | Per `(controller_id, mcp_name)` — each controller approves independently |
| **Type 1 (hand-written, yaml-listed)** | `mcp/local/<name>/` with `server.ts` + yaml entry | Shared, no approval gate (yaml = pre-existing acceptance from all controllers) | `dir/.env` + optional session-creds | None |
| **Type 3 (Twilio bundle)** | `bundles/<name>/` → runtime venv at `/opt/bundled-mcps/<name>/.venv` | Shared, no approval gate | `dir/.env` + optional session-creds | None |
| **Type 2 (controller-pushed 3rd-party)** | Controller UI → `mcp-config-snapshot` frame → connector RAM | **Private to the pushing controller** — only visible in that controller's manifest, only reachable from that controller's tunnel | That controller's `creds-request` / `creds-update` frames | N/A (creation implies acceptance) |

**Key simplification (Q4 resolution):** the DB stores tunnel creds only — bearer / OAuth secret / registration token per controller. Per-MCP runtime env for shared MCPs stays in `dir/.env` on the connector filesystem (customer-managed via git or filesystem drops). The inspector is a **tunnel-registration control plane**, not a per-MCP creds vault.

**Load-bearing consequence — "shared" only fits MCPs whose creds are customer-scoped, not controller-scoped.** An MCP whose creds differ per controller (Twilio, Segment, Salesforce, any per-account SaaS) MUST be Type 2 (private per controller), which spawns a separate child process per controller with that controller's env. An MCP whose creds are the same regardless of caller (customer's own knowledge base with a service account, no-creds utilities, internal customer systems) is a good fit for shared. This is why the prior `mcp/bundled/twilio/` Type 3 bundle was retired 2026-06-30 in favor of the standalone `@deshartman/twilio-mcp` npm package pushed via Type 2 — different Twilio Accounts across controllers need different processes, not a shared one dispatching by request-time creds. See §"Cred-scope decision — is my MCP shared or Type 2?" for the picker rule.

Every RPC frame is scoped by the tunnel it arrived on. The dispatcher enforces: "controller A cannot call controller B's Type 2 MCPs, cannot see them in its manifest, and cannot allocate a webhook against them." Cross-controller enumeration of private MCPs is impossible by construction — each tunnel sees a filtered supervisor view.

Shared MCPs (Type 1 approved-by-me + Type 1 yaml + Type 3) are the same underlying **process** for every controller — one `weather` child, one `enterprise-knowledge` venv — but each controller's manifest independently lists them (or doesn't, per approval) and each controller's RPCs route to the shared process with the caller's controller-id threaded through as context.

## Motivating scenarios — why customers ask for this

1. **Twilio-controller + partner-controller.** A customer wires their connector to Twilio's controller for AI Assistants / ConversationRelay, and *also* to a partner platform's controller (a workflow tool, a support-desk vendor) that speaks the same tunnel protocol. Both want to reach the customer's private CRM MCP. Today the customer runs two connector processes, duplicates Type 3 venvs (RAM waste), duplicates drop-in trees (disk waste + drift), and has to keep two `.env`/yaml pairs in sync. The pitch is: *one connector, both sides plug in, done.*
2. **Prod-controller + staging-controller** for the same customer, side-by-side. Same connector reachable from both. Staging can push a new Type 2 MCP for testing without touching prod's roster.
3. **Twilio-account-sharding.** A single customer with N Twilio accounts (multiple business units, or an ISV / master-account topology) doesn't want N containers.
4. **Consulting / SI shape.** An implementation partner runs its own controller for internal tooling AND connects the same connector to the end-customer's own Twilio controller.

**Not in scope:** the connector serving *different customers*. Multi-controller is still one customer with several controller relationships — same tenant, same trust boundary, same infrastructure. True multi-tenancy (one connector, multiple customer isolation domains) is a different architecture (address-space isolation, hard resource caps, RBAC) and stays out of this doc.

## Current state — where the single-controller assumption is baked in

Enumerating the load-bearing single-controller assumptions in the codebase (grep-able concepts, not exhaustive line references):

| Surface | Current shape | Multi-controller implication |
|---|---|---|
| `.env` at CWD | `CONTROLLER_URL`, `CONNECTOR_NAME`, `TUNNEL_AUTH_TOKEN` (or `OAUTH_*`) — global env | Must become N controller rows in a store |
| `.connector-state.json` at CWD | `{ registrationToken }` — single token | Becomes per-controller in DB |
| `connector.yaml` `tunnel:` block | one URL, one name | Becomes N tunnels; yaml keeps `mcp_servers:` for shared bundle entries only |
| `TunnelClient` in `packages/connector/src/tunnel/client.ts` | Single instance in `main()` | N instances, one per controller; each with its own coordinators |
| `McpConfigCoordinator` (Type 2 roster) | Constructed once per process, one snapshot generation | N instances, each owning a per-controller roster and a per-controller `nameToMcpId` map |
| `CredsCoordinator` | Rebuilt per-tunnel (already close to the target shape) | Multiplied N-way |
| `LocalMcpsCoordinator` (drop-in rescan) | Rebuilt per-tunnel | Stays per-tunnel; W-L2 rescan is triggered by *any* controller and results are visible to *every* controller (each controller sees its own approval-filtered manifest of the rescanned drop-ins) |
| `WebhookRegistry` | Keyed by `mcp_name` | Keyed by `(controller_id, mcp_name)`; a shared MCP can hold at most one active webhook, owned by the allocating controller (see §"Webhooks in multi-controller world") |
| `McpSupervisor` | `Map<string, Entry>` keyed by mcp name | Keyed by *ownership scope*: `Map<"shared" | ${controllerId}, Map<string, Entry>>` — see §"Supervisor keying" |
| Inspector UI | Single-controller view | Per-controller tab / dropdown; a dedicated "shared" view for Type 1/3 |
| RPC dispatcher | Splits `${server}.${tool}` and looks up in `servers: Map` | Splits, then narrows the lookup by the caller's `controllerId` context |
| Manifest builder | Assembles one manifest for the connector | Assembles N manifests — one per controller, filtered by ownership + approval |

All of these are already ~localized in the codebase; the surface area of the change is broad but shallow.

## Goals

1. **N controllers, one process.** A single connector container / process opens N outbound WSS tunnels concurrently. Each connects, registers, handshakes with its own creds.
2. **Ownership per Type 2 MCP.** A Type 2 MCP created by controller A is visible ONLY on controller A's tunnel. Enumerable only by A. Callable only from A. Rotatable only by A. Removable only by A.
3. **Shared Type 1 + Type 3.** Local drop-ins and Twilio bundles are one underlying process each; every controller sees them (subject to the drop-in approval gate, evaluated per-controller).
4. **Per-controller creds without cross-leak.** Each controller's `creds-response`/`creds-update` frames only reach the MCPs it owns. A controller cannot inject env into shared MCPs by design (see §"Creds precedence in multi-controller world").
5. **Encrypted persistence.** Controller URLs are non-secret; **bearer tokens, OAuth client secrets, and any operator-pasted MCP creds are encrypted at rest** in the DB.
6. **Inspector as control plane.** Adding a controller, rotating a bearer, pasting shared-MCP creds, revoking a controller, approving a drop-in for a controller — all through the localhost inspector. No editing files.
7. **From-scratch setup, no legacy import.** New customers configure their first controller entirely via the inspector after boot. `TUNNEL_AUTH_TOKEN` / `CONTROLLER_URL` / `CONNECTOR_NAME` in `.env` are no longer read (log-and-ignore for inherited files). This is a from-scratch design shift, not a backwards-compat promise (Q10 resolution).
8. **Fault isolation.** One controller's tunnel dropping (network flap, its cluster restarting, its bearer rotated invalidly) does not affect the other tunnels or the shared MCPs.
9. **Preserve every invariant in `CLAUDE.md` §"Architecturally load-bearing properties".** Outbound-only, no LLM in the connector core, inspector localhost-only, session creds loopback-only, trust boundary per MCP (now: per (controller, MCP)).

## Non-goals

- **Multi-tenancy across trust boundaries.** One connector serving unrelated customers is out of scope; nothing in this design tries to isolate against a hostile controller *within the same connector*. A malicious or compromised controller can still exhaust connector RAM (spawn N Type 2 stdio processes), spam frames, or crash the process. Same trust posture as today (the customer chose to plug that controller in) — just N-way.
- **Cross-controller MCP sharing at runtime.** Controllers cannot see each other's Type 2 MCPs. Not "hidden by default with an opt-in flag"; not surfaceable at all through the wire protocol. If two controllers both need "salesforce," each pushes its own — even if they end up with the same command line.
- **HA / clustering.** Still one process per container. If the process dies, all tunnels drop; the orchestrator restarts. No connector-side leader election, no state replication.
- **Multi-process fanout.** We do not spawn one child per controller pair. Shared MCPs stay singleton processes. Splitting into per-controller processes would defeat the point (memory duplication, cold-start cost).
- **Controller-to-controller trust.** No design here relies on controllers cooperating. They don't know about each other, they don't sync state, they don't authenticate to each other.
- **Live reconfiguration of shared MCPs from Type 1/3.** The yaml + `mcp/local` filesystem still governs the shared roster. Adding a new drop-in is still a filesystem write; adding a Type 3 is still a yaml edit. Multi-account only widens *who can approve/consume* those MCPs, not *how they're introduced*.

## Design principles

Invariants inherited from `CLAUDE.md` — all preserved, several sharpened:

| # | Invariant | Multi-account tightening |
|---|---|---|
| I1 | **Outbound-only.** No inbound ports for tunnels. | Now N outbound dials, still zero inbound. |
| I2 | **Trust boundary is per MCP, not per tool.** | Now **per (controller, MCP)** for Type 2; **per (controller, MCP)** for Type 1 drop-in approvals; **shared across controllers** for Type 1 yaml + Type 3. |
| I3 | **Customer drop-ins gated by controller approval.** | Approval is a `(controller_id, mcp_name)` pair. Controller A approving does not approve for B. |
| I4 | **Identity established at register-frame time.** | Each tunnel registers separately, mints its own registration token bound to that controller row. |
| I5 | **No LLM, no agent loop, no document handling in the connector core.** | Unchanged. Applies process-wide. |
| I6 | **Webhook ingress preserves outbound-only.** | Each controller mints its own webhook URLs. Still no inbound port on the connector. |
| I7 | **Inspector is localhost-only.** | Now renders N controller views + a shared view. Still bound to 127.0.0.1. |
| I8 | **Session creds are loopback-only, in-memory, write-only on the wire.** | Session creds attach to the (controller_id, MCP) scope. A session-cred pasted for a shared MCP applies across every controller (it's a connector-local override). See §"Session creds & shared MCPs". |

New invariants introduced by this design:

| # | New invariant | Rationale |
|---|---|---|
| N1 | **Every RPC frame carries an implicit controller-id (the tunnel it arrived on).** The dispatcher enforces manifest-visibility gates using that id. | Prevents cross-controller RPC leakage. Without this, controller A could speculatively call `tools/call foo.bar` where foo is B's Type 2 and get through. |
| N2 | **The supervisor's canonical key for MCP entries is `(scope, mcp_name)` where `scope ∈ {"shared", controllerId}`.** Not just `mcp_name`. | Prevents Type 2 name collisions across controllers. Two controllers can both call their MCP "salesforce" without interference. |
| N3 | **The controller UI's Tunnel Security row exists on each controller separately.** Each controller mints its own bearer / OAuth client. The connector holds one row per controller in its DB. | Preserves the existing per-controller identity model; no cross-controller shared secret to compromise. |
| N4 | **DB is authoritative for controller registrations; the `.env` file is a bootstrap path only.** After first migration, edits to `.env` no longer take effect on the tunnel it originally seeded. | Prevents "why is my rotated bearer not applying" confusion. One source of truth. |
| N5 | **Shared-MCP creds pasted via the inspector are connector-local (not controller-scoped) and do NOT cross the wire to any controller.** | Preserves the "controllers don't see other controllers' state" property even when the operator uses one connector to service many. |
| N6 | **Master encryption key material never leaves the connector host.** No controller-side key escrow; no cloud KMS on the customer's behalf. | The customer owns their controller registrations end-to-end. Loss of the key = re-add each controller (fresh Tunnel Security row + new bearer). Acceptable operational cost. |

## Ownership model — the three MCP kinds under multi-controller

The single most consequential decision in this design. Every downstream question (routing, creds, approval, webhooks, inspector UI) flows from here.

### Type 2 — private per controller

- **Introduction:** Controller UI → `mcp-config-snapshot` / `mcp-config-delta` frame on **that controller's** tunnel.
- **Ownership scope:** `controllerId` of the pushing tunnel. Stored in `McpStatus.owner = controllerId`.
- **Manifest visibility:** Only in the pushing controller's `register.manifest` and subsequent `manifest-delta` frames.
- **RPC reachability:** `tools/call ${server}.${tool}` for that MCP works only on the pushing controller's tunnel. Reaching from another tunnel returns the standard `-32601 method not found` or `-32602 unknown server` (matching what today's dispatcher returns for a truly-unknown name — do NOT return a controller-aware "access denied," which leaks that the MCP exists on the connector).
- **Creds:** `creds-request` / `creds-response` / `creds-update` for that MCP flow only over the pushing controller's tunnel.
- **Webhooks:** Only the pushing controller can allocate `webhook-allocate` for that MCP.
- **Lifecycle:** Introduced by `mcp-config-snapshot`/`delta`, removed by `delta.removed`, GC'd when the pushing controller's row is deleted from the DB.

### Type 3 — Twilio bundle, shared across controllers

- **Introduction:** `connector.yaml` `bundled: <name>` line, resolved against `BUNDLED_MCPS` at boot. No wire-protocol path.
- **Ownership scope:** `"shared"`. `McpStatus.owner = null` (semantically "no controller owns it").
- **Manifest visibility:** In **every** controller's manifest. No approval gate — Twilio bundles are pre-existing acceptance by virtue of the customer choosing this connector build.
- **RPC reachability:** From every controller's tunnel. Dispatcher routes `tools/call ${bundle}.${tool}` from any tunnel to the one shared process.
- **Creds:** Sourced from `dir/.env` on the connector filesystem (customer-managed). Optionally supplemented at runtime by session-creds (loopback-only, in-memory, 12h TTL) for dev/debug. **Not** sourced from `creds-request` — shared MCPs have no owning controller, and mixing controller-supplied env into shared processes would violate the "no controller owns state that outlives its own tunnel" property.
- **Webhooks:** Allocatable, but the allocation is *per controller* (see §"Webhooks in multi-controller world" for the design choice). A shared bundle rarely needs webhooks in practice.
- **Lifecycle:** Introduced at boot, retired when the yaml entry is removed and the process is restarted.

### Type 1 hand-written (yaml-listed) — shared, no approval

- **Introduction:** `connector.yaml` entry with `transport: http` + `dir:` + no `endpoint:`. Escape hatch retained; new work uses drop-in shape.
- **Ownership scope:** `"shared"`.
- **Manifest visibility, RPC reachability, webhooks:** Same as Type 3 (shared, no gate). Yaml listing = pre-existing acceptance.
- **Creds:** `dir/.env` on disk + optional session-creds. Same as Type 3.

### Type 1 drop-in — shared PROCESS, per-controller APPROVAL

This is the subtle one.

- **Introduction:** Customer admin drops `mcp/local/<name>/tools/*.ts` (via git, image build, or `MCP_DROPIN_DIR` volume mount). Detected at boot AND on W-L2 rescan.
- **Ownership scope:** `"shared"` — one process, spawned once, its tools discovered once.
- **Approval model:** On boot / rescan-add, the connector emits `mcp-discovered` to **every currently-connected controller**. Each controller decides independently whether to approve. Approval state is `(controller_id, mcp_name) → bool`, stored ONLY in each controller's own persistence (per current CLAUDE.md rule — connector holds no approval persistence; controllers replay `mcp-enable` after every `register-ack`).
- **Manifest visibility:** Each controller's manifest lists a drop-in **only if that controller has enabled it**. The other controllers see nothing for that name.
- **RPC reachability:** Controller A calling a drop-in it hasn't enabled gets the same `-32601 / unknown server` as any other unknown name. The dispatcher enforces per-controller enable state as an explicit gate.
- **Creds:** `dir/.env` on the connector filesystem + optional session-creds (loopback-only, ephemeral). Same source as any other shared MCP. A drop-in that needs Twilio creds pushed from a specific controller should be re-shaped as a Type 2 (controller-pushed) instead.
- **Webhooks:** Same as Type 3.
- **Lifecycle:** One shared process. Disabled state on all controllers = process still runs; it's cheap. Removing the folder + rescan = process stopped, all `mcp-disable` frames implicit.

### Summary matrix

For picker-level guidance ("which kind is my new MCP?"), see §"Cred-scope decision" above — the cred-scope question is the deciding factor.

| Property | Type 2 (private) | Type 1 drop-in (shared, gated) | Type 1 yaml / Type 3 (shared, ungated) |
|---|---|---|---|
| Underlying processes | One per controller | One shared | One shared |
| Manifest inclusion for controller X | X pushed it | X approved it | Always |
| RPC callable by X | X pushed it | X approved it | Always |
| Webhook allocatable by X | X pushed it (owner) | X approved it | Any approved controller (see webhook policy) |
| Creds source | X's `creds-response`/`update` | `dir/.env` + optional session-creds (ephemeral) | `dir/.env` + optional session-creds (ephemeral) |
| Removed when X disconnects | Stays running until X removes it or its row is deleted from DB | Stays running (other controllers may still consume it) | Stays running |
| Wire naming collision across controllers | Rejected at push time — global uniqueness rule. X and Y cannot both call theirs "salesforce"; the second one gets `takenBy: "other-controller"`. Suggested convention: `service_controller_account` (e.g. `twilio_prod_us`, `twilio_staging_au`) | N/A — one process, one name | N/A |

## Cred-scope decision — is my MCP shared or Type 2?

A concrete picker rule for anyone adding a new MCP under multi-account. Ask: **"For this MCP, are the runtime creds the same regardless of which controller invokes it, or do they differ per controller?"**

| If creds are… | Then the MCP is… | Where creds live | Process shape under multi-controller |
|---|---|---|---|
| **Customer-scoped** — same customer, same set of creds, regardless of caller (customer's own GDrive service account, their internal DB, their own S3 bucket; or no creds at all) | **Shared** — Type 1 drop-in / Type 1 yaml / Type 3 bundle | `dir/.env` on the connector filesystem | **One process, serving every controller.** Each controller's manifest lists it (subject to drop-in approval); every controller's `tools/call` routes to the same child. |
| **Controller-scoped** — different creds per controller, because each controller is a different Twilio Account / Segment workspace / Salesforce org / SaaS tenant | **Type 2 (private per controller)** — pushed via controller UI → `mcp-config-snapshot` | Pushed by each controller via `creds-response` / `creds-update` (encrypted per wire-encryption plan) | **One process per controller.** Two controllers wiring the same MCP name spawn two isolated children with different env. |

The rule is a natural consequence of Q4's resolution: shared MCPs don't consume `controllerEnv[*]`, and the only way to inject different creds per caller into a shared process would be per-request creds (see "Rejected — Twilio-as-shared with per-request creds" below).

### Concrete examples in this repo

| MCP | Cred nature | Correct shape |
|---|---|---|
| `sample` drop-in (weather.gov, now, uuid, slow-echo) | No auth needed | Shared Type 1 drop-in |
| `enterprise-knowledge` (customer's own knowledge sources — GDrive, S3, local) | Customer-scoped: the customer's own service account, same regardless of controller | Shared Type 3 bundle with `dir/.env` |
| `crm` (dev-only, customer's mock CRM) | Customer-scoped: local endpoint, no per-controller variance | Shared Type 1 drop-in |
| `@deshartman/twilio-mcp` (Twilio AccountSid + AuthToken) | **Controller-scoped**: each controller has its own Twilio Account | **Type 2**, pushed via each controller's UI |
| `@deshartman/segment-mcp` (Segment write key) | **Controller-scoped**: each controller has its own Segment workspace | **Type 2**, pushed via each controller's UI |
| Future: aviation-weather MCP | No auth needed | Shared Type 1 drop-in / bundle |
| Future: customer-authored CRM to internal Snowflake | Customer-scoped (one Snowflake account across all controllers) | Shared Type 1 drop-in |
| Future: partner-authored Salesforce MCP where each controller owns its own SF org | Controller-scoped | Type 2 |

### One controller managing multiple accounts of the same SaaS

A controller that manages more than one Twilio Account (or Segment workspace, or Salesforce org) does NOT need multiple controllers — it just adds multiple Type 2 entries in its own roster, each with a distinct `name` and its own creds. Concrete example, Controller A managing two Twilio Accounts:

```
mcp-config-snapshot from Controller A:
  entries: [
    { mcpId: "abc-123", name: "twilio_account1",
      command: "npx @deshartman/twilio-mcp",
      env: { TWILIO_ACCOUNT_SID: "AC-aaa…", TWILIO_AUTH_TOKEN: "…" } },
    { mcpId: "def-456", name: "twilio_account2",
      command: "npx @deshartman/twilio-mcp",
      env: { TWILIO_ACCOUNT_SID: "AC-bbb…", TWILIO_AUTH_TOKEN: "…" } }
  ]
```

Connector supervisor spawns **two isolated child processes** under `entries.get(ctrlAId)` — one per Account. Controller A's manifest surfaces `twilio_account1.<tool>` and `twilio_account2.<tool>` side by side. `tools/call twilio_account1.messages_create` dispatches to the account-1 child; the account-2 child never sees it. Two Twilio SDK instances, two Account identities, hard process isolation.

**Load-bearing rule:** within one controller's roster, `name` must be unique. The controller UI enforces this at push time (two entries with `name: "twilio"` in one snapshot would collide at the connector's `nameToMcpId` map). Distinct names — `twilio_account1` / `twilio_account2`, or `twilio_prod` / `twilio_staging`, or `twilio_us` / `twilio_au` — are how the operator disambiguates. Across controllers, names may collide freely (private-vs-private in different scopes, per Q3).

Nothing in multi-account changes this shape — the same-controller-N-accounts flow works today in single-controller mode. Multi-account is orthogonal (cross-controller isolation on top of within-controller multi-instance isolation).

### Rejected — "Twilio-as-shared with per-request creds"

**Shape:** one shared `twilio-mcp` process. Each tool's schema requires `accountSid` and `authToken` (or an opaque session handle) as arguments. Each controller injects its own creds into `tools/call` params. The MCP is stateless per-request.

**Why rejected:**
- **Not how the SDK works.** `@deshartman/twilio-mcp` and every production Twilio SDK read creds at construction. Making them per-request means re-authoring every tool.
- **Cred surface expands.** Env values live in one place (spawn env); per-request creds live in every `tools/call` frame, every inspector Frames-panel entry, every MCP-side log. Larger blast radius on any single leak channel.
- **One process holds N controllers' identities simultaneously in memory.** A bug in the MCP that leaks its arg list leaks every controller's creds at once. Isolated processes leak at most one controller's identity per bug.
- **Controller-side complexity.** The controller would need to rewrite `params.arguments` on every outbound `tools/call` to inject its own creds. Type 2 injects creds once at spawn.
- **The Type 2 cost isn't real.** A Node MCP is 30–60MB RSS. Five controllers × one Twilio MCP = ~250MB. Trivial vs. the isolation win.

**Verdict:** Type 2 (one process per controller) is the right shape. Per-request creds is a pattern; it just isn't the right one for connectorized MCPs where the trust boundary is per-controller by design.

## Component architecture

### Process shape

```
                    ┌────────────────────────────────────────────────────────────┐
                    │  connector process (one per container, one per customer)   │
                    │                                                            │
                    │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
   Controller A ◄───┼───┤ TunnelClient │   │ TunnelClient │   │ TunnelClient │───┼───► Controller C
   (wss out)        │   │      A       │   │      B       │   │      C       │   │   (wss out)
                    │   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   │
                    │          │                  │                  │           │
                    │   ┌──────┴──────────────────┴──────────────────┴────────┐  │
                    │   │           TunnelHub  (multi-tunnel router)          │  │
                    │   │   - manifest builder (per-controller filtered view) │  │
                    │   │   - rpc dispatcher  (controllerId → scoped lookup)  │  │
                    │   │   - creds fanout   (per-controller coordinator)     │  │
                    │   │   - mcp-config coordinators (per-controller Type 2) │  │
                    │   │   - webhook registry (keyed by (ctrlId, mcp))       │  │
                    │   └───────────────────────┬─────────────────────────────┘  │
                    │                           │                                │
                    │   ┌───────────────────────┴─────────────────────────────┐  │
                    │   │              McpSupervisor (singleton)              │  │
                    │   │   Map< "shared" | ctrlId , Map<name, Entry> >       │  │
                    │   │   - spawns / restarts child processes               │  │
                    │   │   - merges env layers (see precedence)              │  │
                    │   │   - tracks per-entry ownership scope                │  │
                    │   └───────────────────────┬─────────────────────────────┘  │
                    │                           │                                │
                    │   ┌────────────┐  ┌───────┴──────┐  ┌─────────────────┐    │
                    │   │ Shared MCPs│  │ ctrlA-only   │  │ ctrlB-only      │    │
                    │   │            │  │ Type 2 MCPs  │  │ Type 2 MCPs     │    │
                    │   │ - sample   │  │ - salesforce │  │ - jira          │    │
                    │   │ - EK bundle│  │ - twilio     │  │ - slack         │    │
                    │   └────────────┘  └──────────────┘  └─────────────────┘    │
                    │                                                            │
                    │   ┌───────────────────────────┐  ┌────────────────────┐    │
                    │   │  ConfigStore (Postgres)   │  │  Inspector (127.1) │    │
                    │   │  - controllers table      │  │  - per-ctrl tabs   │    │
                    │   │  - creds (encrypted)      │  │  - shared view     │    │
                    │   │  - registration_tokens    │  │  - add-controller  │    │
                    │   └───────────────────────────┘  └────────────────────┘    │
                    └────────────────────────────────────────────────────────────┘
```

### Component responsibilities

**`TunnelClient` (one per controller).** Same responsibilities as today, but instantiated N times. Owns one WSS, one register/register-ack cycle, one heartbeat loop, one reconnect state machine. Its constructor takes a `ControllerRegistration` record from the DB (URL, name, bearer or OAuth provider, master key material for sealed-box encryption). Publishes inbound frames to the TunnelHub tagged with its `controllerId`.

**`TunnelHub` (new — replaces the ad-hoc wiring in `main()`).** The routing brain. Owns the map of tunnels, the per-controller `CredsCoordinator` / `McpConfigCoordinator` / `LocalMcpsCoordinator`, and the shared `McpSupervisor`. Responsibilities:
- Build per-controller manifests by filtering the supervisor's entries via `(scope === "shared" && approvedFor(ctrlId)) || scope === ctrlId`.
- Route inbound RPC frames to the supervisor with controllerId threaded through, so the supervisor can enforce N1 (visibility gate).
- Fan out `mcp-discovered` to every currently-connected controller when a drop-in is added.
- Fan out `manifest-delta` to only the affected controllers when creds land / a Type 2 is added / an approval flips.
- Handle inspector-driven actions (add controller, remove controller, rotate secret, approve for controller X) by mutating the DB then reconciling in-memory state.

**`McpSupervisor` (one, extended keying).** Today `Map<string, Entry>`. New: `Map<Scope, Map<string, Entry>>` where `Scope = "shared" | ControllerId`. Each `Entry` gains `owner: Scope`. Existing methods (`register`, `startAll`, `restart`, `stopAll`, `applyControllerEnv`, `applySessionEnv`) get a `scope` parameter, defaulting to `"shared"` for backwards compat with today's boot path. New helpers:
- `registerForController(ctrlId, spec)` — Type 2 push.
- `unregisterForController(ctrlId, mcpName)` — Type 2 remove.
- `entriesVisibleTo(ctrlId, approvedNames: Set<string>): Entry[]` — computes the per-controller manifest slice.
- `dispatchRpc(ctrlId, mcpName, method, params)` — enforces visibility, then delegates to the underlying `McpServerConnection`.

**`ConfigStore` (new).** Postgres-backed persistence (schema `mcp_connector` in the same DB that hosts `enterprise-knowledge`'s tables). See §"Database design" for schema. All controller-registration state and all encrypted credential material live here. The store is the *only* thing outside the connector core that changes durable state; every other file (`.env`, `connector.yaml`, `.connector-state.json`) becomes a bootstrap surface.

**`Inspector` (extended).** Same process, same 127.0.0.1 bind, same trust boundary. Renders a per-controller tab strip + a "Shared" pseudo-tab for Type 1/3. Adds pages for:
- Add a controller (URL + Tunnel Security bearer OR OAuth client + connector name).
- Rotate a controller's bearer.
- Remove a controller (with the connector-side implications spelled out — "removing this will drop this controller's tunnel, retain shared MCPs, and stop any Type 2 MCPs it introduced").
- Approve a drop-in for controller X (per §I3).
- Paste shared-MCP creds (marked "connector-local; not sent to any controller").

### Supervisor keying — the concrete data structure

Today, one flat map:

```
supervisor.entries: Map<string, Entry>
  "sample" → { spec, child, connection, status: { … } }
  "weather" → { … }
```

Multi-account, two-level:

```
supervisor.entries: Map<Scope, Map<string, Entry>>
  "shared" → Map
    "sample"   → { spec, child, connection, status: { owner: "shared" } }
    "weather"  → { spec, child, connection, status: { owner: "shared" } }
    "enterprise-knowledge" → { … , status: { owner: "shared" } }
  "ctrlA-xyz" → Map
    "salesforce" → { spec, child, connection, status: { owner: "ctrlA-xyz", mcpId: "abc-123" } }
  "ctrlB-abc" → Map
    "salesforce" → { spec, child, connection, status: { owner: "ctrlB-abc", mcpId: "def-456" } }
```

Look-up rules:
- **Controller X calls `tools/call salesforce.foo`:** supervisor looks up `entries.get(ctrlXId)?.get("salesforce")`. If present, dispatch there. If absent, check `entries.get("shared")?.get("salesforce")` — a match here can only happen if X has approved (visibility gate). No cross-scope name collision is possible because the push-time check (below) rejects it.
- **Controller X calls `tools/call sample.now`:** supervisor consults `entries.get("shared")?.get("sample")` (hit). Visibility gate then checks whether ctrlX has approved "sample" — if not, respond as if unknown.
- **`mcp-config-snapshot` from controller X removes salesforce:** supervisor tears down `entries.get(ctrlXId).get("salesforce")` only. `entries.get(ctrlYId).get("salesforce")` is untouched.
- **Boot:** yaml + drop-ins populate `entries.get("shared")`. Controller-config coordinators, once their tunnels come up and snapshots land, populate `entries.get(ctrlXId)` per controller.

**Name-collision rule (Q3 + Q3-refinement 2026-07-09).** Names must be **globally unique on this connector**. Any collision at push time is rejected with a descriptive per-entry ack.

The three collision cases:
- **Vs a shared entry** (Type 1 yaml, Type 1 drop-in, Type 3 bundle) → `mcp-config-ack { perMcp: [{mcpId, name, status: "skipped", error: "name_taken", takenBy: "shared", existingName: "<name>"}] }`. The controller UI renders: "**<name>** is already used by a shared MCP on this connector. Please pick a different name."
- **Vs the same controller's own private roster** (operator tried to push two entries with the same `name` in one snapshot, or a delta.added collided with an existing entry) → `error: "name_taken", takenBy: "your-roster", existingName: "<name>", existingMcpId: "<mcpId>"`. The controller UI can highlight the pre-existing entry so the operator knows what to rename or remove first.
- **Vs another controller's private roster** → `error: "name_taken", takenBy: "other-controller", existingName: "<name>", ownerHint?: "<label>"`. `ownerHint` echoes the owning controller's operator-set label (e.g. `"twilio-prod-AC1234abc"`) if the row has one; omitted otherwise. **Q3-refinement-2 (2026-07-09):** strict N1 opacity is deliberately relaxed here — all controllers on one connector serve the same customer, so exposing "one of your own controllers already owns this name" is informative rather than a leak.

Other entries in the same snapshot/delta are processed normally (per-entry ack; the rest of the roster reconciles).

Shared-vs-shared collision at boot (yaml + drop-in with the same folder name) is already resolved today: yaml wins over drop-in per the existing drop-in scanner. Unchanged.

**Rationale for global uniqueness:**
- Operator mental model: "on this connector, a name is either taken or free." Simpler than "well, it depends on which controller you're on and whether the shared roster has one."
- Prevents inspector-side confusion where the operator sees `salesforce` on Controller A's tab and `salesforce` on Controller B's tab and can't tell if they're the same MCP.
- The multi-account-Twilio case (customer with `twilio_us` on A and `twilio_us` on B) is not blocked in practice — the customer already needs distinct names across their Accounts (per §"One controller managing multiple accounts of the same SaaS"), and extending that to cross-controller is a small friction cost for a big clarity win.
- Trade-off acknowledged: the customer must coordinate names across controllers. Suggested naming convention (surface in controller UI): `<service>_<controller>_<account>` — e.g. `twilio_prod_us`, `twilio_prod_au`, `twilio_staging_us`. The controller UI's "New 3rd Party MCP" form should surface the collision error inline so the operator retries with a distinct name.

### Tunnel process — what happens on `boot()`

```
1. Load env for bootstrap: LOG_LEVEL, INSPECTOR_PORT, MCP_BASE_PORT,
                           POSTGRES_URL (or split form), POSTGRES_SCHEMA,
                           MCP_DROPIN_DIR (default ./mcp/local dev, /var/lib/... prod).
2. Open ConfigStore (Postgres). Fail-fast if unreachable. Run pending migrations
   (node-pg-migrate; idempotent on already-current schema).
3. Master-key resolution — see §"Encryption strategy". This must succeed before
   ANY encrypted column can be read; refuse to boot otherwise.
4. Load connector.yaml — same as today. Its mcp_servers[] entries are
   registered into supervisor with scope="shared".
5. Discover drop-ins under MCP_DROPIN_DIR → scope="shared" entries in supervisor.
   Approval state is per-controller; the shared spec is registered regardless.
6. Start ALL shared entries. Type 1/3 processes spawn and readiness-probe as today.
7. Start the inspector (127.0.0.1:INSPECTOR_PORT).
8. For each row in ConfigStore.controllers where enabled=true:
      a. Instantiate a TunnelClient with that row's credentials.
      b. Bind it to the TunnelHub.
      c. Dial. On WS-open, send register frame with:
         - manifest = supervisor.entriesVisibleTo(ctrlId, approvedForCtrl) rendered
           as ToolManifest — INCLUDES only entries that are (a) shared AND
           previously-approved by this controller, or (b) private-scoped to
           this controller (there won't be any yet — snapshots come after
           register-ack).
         - name = row.connector_name
         - registrationToken = row.registration_token (may be null on first
           connect for a freshly-added row)
         - connectorPublicKey — per CREDS-ENCRYPTION.md, one keypair per PROCESS,
           shared across every tunnel's register frame.
9. Handle register-ack from each controller independently. Controllers whose
   ack carries a fresh registrationToken: persist it back to ConfigStore.
10. Steady state: each tunnel runs its own heartbeat, its own creds-request /
    creds-update / mcp-config-snapshot handling, its own mcp-enable replay.
11. On SIGTERM: TunnelHub.shutdown() sends goodbye on every tunnel in parallel,
    stopAll() on supervisor kills every shared + private child.
```

**Boot ordering guarantee.** Shared MCPs are started BEFORE the first tunnel is dialed. This preserves today's invariant that a controller's `register` frame carries a fully-populated manifest of everything it can reach. A late-arriving controller's `register-ack` triggers `mcp-config-snapshot` which spins up that controller's private Type 2 entries; those show up in the follow-up `manifest-delta` frame, same as single-controller today.

### Fault isolation

- **Tunnel A drops (network flap).** Its `TunnelClient` transitions to `reconnecting` state per today's backoff logic. The tunnel-scoped `CredsCoordinator` and `McpConfigCoordinator` for A are per-tunnel-rebind (via `.bind({send})`) so they survive across the reconnect — same guarantee CLAUDE.md pins in "LIFETIME comment in that file for the 2026-06-21 manual repro." A's private-scope Type 2 MCPs **keep running** (they're supervised processes; disconnected controller doesn't kill them). Shared MCPs are unaffected. B's tunnel is unaffected. When A comes back, its register-ack triggers a fresh `mcp-config-snapshot` which reconciles A's private roster and the `mcp-enable` replay restores approval state.
- **Tunnel A permanently rejected (bearer revoked at the controller).** A goes to `closed` state; `registrationRejected` flag is set (existing logic). The connector logs, does NOT auto-reconnect, and the inspector surfaces a red badge on A's tab. Operator's recovery: rotate the row's bearer in the inspector.
- **All tunnels drop simultaneously (customer's egress firewall bounces).** All shared and private MCPs keep running. Inspector shows all `reconnecting`. When connectivity restores, each tunnel independently reconnects; each controller's register-ack triggers its own state resync.
- **ConfigStore unreachable at boot (disk gone, permission error).** Boot fails fast with a clear error naming the DB path. No partial boot into a "no controllers configured" state — that would be indistinguishable from a fresh install and could cause confusing behavior.
- **Master key material lost.** Same as ConfigStore unreachable — fail fast. Recovery: re-add each controller through the inspector (fresh Tunnel Security row minted on each controller side, fresh bearer pasted in).
- **One controller sends a malformed frame.** Only that tunnel's decoder errors; the frame handler returns early with a log. Other tunnels unaffected. Same behavior as today's single-controller frame decoder.
- **One controller spams frames.** No rate-limiting today; multi-account inherits this. If it becomes an issue, per-tunnel token buckets are a localized addition. See §"Open questions" Q7.

## Database design

### Why Postgres

**Postgres, not SQLite (Q2 resolution 2026-07-09).** The connector deployment already runs Postgres for the `enterprise-knowledge` bundle (llamaIndex vector store, source ingestion metadata). Multi-account reuses that instance.

- **Zero new infrastructure.** The Postgres container is already in the customer's compose / K8s manifest for the Type 3 bundle. Adding a `mcp_connector` schema costs nothing operationally.
- **Concurrent writes.** Multiple tunnel-add / rotate-secret / approval events can proceed without a global mutex. SQLite's `better-sqlite3` is sync-only; Postgres' `pg` driver is naturally async.
- **Standard migrations.** `node-pg-migrate` or Flyway handle schema evolution — no hand-rolled `schema_version` check.
- **Encryption remains app-side.** libsodium `crypto_secretbox_easy` seals `BYTEA` columns before insert. Postgres' `pgcrypto` extension is *not* used — keeping the sealing in-process is consistent with the wire-encryption plan and avoids requiring a specific Postgres role setup.
- **Boot dependency.** Postgres must be up before the connector boots. Fail-fast on unreachable DB. The customer's compose stack already gates on this for the enterprise-knowledge bundle.
- **Deps footprint:** `pg` (async driver, single dep). Optional `pg-pool` for connection pooling (relevant if inspector routes hit the DB on every request).

**Connection config** via env:
- `POSTGRES_URL` (preferred single-var form: `postgres://user:pass@host:5432/dbname`)
- Or the split form: `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DATABASE` / `POSTGRES_USER` / `POSTGRES_PASSWORD`
- Optional: `POSTGRES_SCHEMA` (default `mcp_connector`) so the connector's tables live under a dedicated namespace and don't collide with llamaIndex's tables in the same database.

### Schema (proposed)

```sql
-- All connector tables live under a dedicated schema (default 'mcp_connector')
-- so they don't collide with llamaIndex tables in the same Postgres database.
CREATE SCHEMA IF NOT EXISTS mcp_connector;
SET search_path TO mcp_connector;

-- Schema version + metadata
CREATE TABLE schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Rows: 'schema_version' → '1', 'created_at' → ISO8601, 'master_key_kdf_salt' → base64

-- Encryption master-key fingerprint (used to detect key-rotation / migration)
CREATE TABLE encryption_meta (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    key_source        TEXT NOT NULL,             -- 'file' | 'passphrase-kdf'
    key_fingerprint   TEXT NOT NULL,             -- SHA-256 of the wrapping key; NOT the key itself
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per controller the connector is registered with.
CREATE TABLE controllers (
    id                     TEXT PRIMARY KEY,         -- ULID minted on insert
    name                   TEXT NOT NULL UNIQUE,     -- human-friendly ("twilio-prod", "partner-x")
    owner_hint             TEXT,                     -- operator-set identifier surfaced in collision errors (e.g. "twilio-prod-AC1234abc"); NULL to omit
    controller_url         TEXT NOT NULL,            -- https://... (not encrypted; not secret)
    connector_name         TEXT NOT NULL,            -- goes into WS X-Connector-Name header
    auth_mode              TEXT NOT NULL CHECK (auth_mode IN ('static-bearer', 'oauth2-cc')),
    -- static-bearer fields (encrypted)
    tunnel_auth_token_ct   BYTEA,                    -- sealed with master key (nonce || ciphertext)
    -- oauth2-cc fields
    oauth_client_id        TEXT,                     -- not secret
    oauth_client_secret_ct BYTEA,                    -- sealed with master key
    oauth_token_url        TEXT,
    -- registration state
    registration_token_ct  BYTEA,                    -- sealed, returned by register-ack, presented on reconnect
    -- lifecycle
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_connected_at      TIMESTAMPTZ,
    last_disconnect_reason TEXT
);
CREATE INDEX idx_controllers_enabled ON controllers(enabled) WHERE enabled = TRUE;

-- Audit trail (append-only). Non-encrypted; deliberately does not carry cred values.
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    controller_id   TEXT,                       -- nullable (for connector-wide events); FK omitted so audit survives controller removal
    kind            TEXT NOT NULL,              -- 'controller.add' | 'controller.remove' |
                                                -- 'controller.rotate' | 'controller.connect' |
                                                -- 'controller.disconnect' |
                                                -- 'creds.controller_pushed' | 'approval.set' |
                                                -- 'approval.clear' | 'webhook.allocate' |
                                                -- 'mcp.push_rejected' | ...
    subject         TEXT,                       -- e.g. mcp name, env key name (never a value)
    detail          JSONB                       -- structured payload; NEVER cleartext creds
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_controller ON audit_log(controller_id) WHERE controller_id IS NOT NULL;
```

**Migration tooling:** `node-pg-migrate` runs the DDL as versioned up/down files. Migrations execute on every connector boot (idempotent) so a fresh Postgres never blocks a first-time connector start.

### What is NOT in the DB

- **Approval state for Type 1 drop-ins.** Per CLAUDE.md §I3: "approval state lives controller-only (replayed via mcp-enable on every register-ack; connector keeps no approval persistence)." Multi-account preserves this — each controller replays its own approvals on register-ack, and the connector rebuilds the per-controller allow-set in RAM. This deliberately keeps the connector free of durable approval state (bug surface + rollback pain).
- **Type 2 MCP definitions.** Also RAM-only per controller, per CLAUDE.md's `McpConfigCoordinator` design. Each controller's `mcp-config-snapshot` on reconnect is the authoritative refresh; persisting the roster in the DB would duplicate the controller's own persistence and risk drift.
- **Session creds.** By design, session creds live in `entry.sessionEnv` in the supervisor, 12h TTL, never persisted. Multi-account does NOT change this. See §"Session creds & shared MCPs".
- **Controller-pushed env values.** Per-controller `controllerEnv` maps also stay in RAM; the controller is authoritative. Reconnect triggers a fresh `creds-request` cycle.
- **Shared MCP runtime env** (Q4 resolution). These stay in `dir/.env` files on the connector filesystem, customer-managed via git or filesystem drops — the same source of truth as single-controller today. The DB is **not** a shared-MCP creds vault. If a shared MCP needs different creds per controller, that MCP should be re-shaped as a Type 2 (controller-pushed) so each controller manages its own copy.
- **Webhook allocations.** Persistent identity is (rowId prefix, mcp_name) but the secret tail re-mints every allocation. Multi-account extends the key to (controller_id, mcp_name); still RAM-only in the connector, controller is authoritative.

The persistence philosophy: **the DB holds tunnel identity + tunnel creds only.** Everything downstream of the tunnel — approvals, Type 2 rosters, controller-pushed creds, shared-MCP runtime env, session creds, webhook allocations — either lives on the connector filesystem (shared-MCP `dir/.env`) or in RAM (controller-authoritative state, re-synced on reconnect).

### Encryption strategy — master-key sourcing (Q1 resolution)

The DB stores three sensitive fields per controller (bearer, OAuth secret, registration token). All are sealed with a **master key** held in the connector's process memory. Target deployment shape is Docker / Kubernetes, so the master-key sourcing is optimized for those runtimes.

| Source | How the key is obtained | Notes |
|---|---|---|
| **`file`** *(default; Docker & Kubernetes)* | 32-byte key read from the path in `CONNECTOR_KEY_FILE` (mode 0600 enforced at boot). Typical mount: K8s `Secret` via projected volume, Docker `--secret` mount, or docker-compose secrets. | Simplest CI/CD story; secret rotation is a K8s / Docker secret update; process picks up the new key on restart. The file itself contains 32 raw bytes (not base64) — matches libsodium's key-length expectation directly. |
| **`passphrase-kdf`** *(portable fallback / dev)* | Operator sets `CONNECTOR_KEY_PASSPHRASE` at process start (env var or TTY prompt). Argon2id derives the master key with a per-DB salt stored in `schema_meta.master_key_kdf_salt`. Argon2id parameters: `t=3, m=64MiB, p=1`. | Portable to any runtime that can set an env var. Trade-off: passphrase must be re-supplied on every restart; env-var handling puts it in `/proc/<pid>/environ` — same posture as today's `TUNNEL_AUTH_TOKEN`. |

`CONNECTOR_KEY_SOURCE` env var picks the mode (default `file`). Boot fails fast with a clear error if the configured source is unusable (file missing / wrong mode / passphrase empty). No silent fallback between sources — the operator's choice is explicit.

**Kubernetes recipe** (canonical shape, documented in the customer-facing deploy guide):
```yaml
# Secret
apiVersion: v1
kind: Secret
metadata: { name: mcp-connector-master-key }
type: Opaque
data:
  master.key: <base64-of-32-raw-bytes>
---
# Deployment mount
volumes:
  - name: master-key
    secret: { secretName: mcp-connector-master-key, defaultMode: 0400 }
volumeMounts:
  - name: master-key
    mountPath: /run/secrets/mcp-connector
    readOnly: true
env:
  - name: CONNECTOR_KEY_FILE
    value: /run/secrets/mcp-connector/master.key
```
**Docker Compose recipe** analogous — `secrets:` block pointing at a host file, mount at `/run/secrets/mcp-connector/master.key`.

**Rotation:** rotating the master key requires re-sealing every encrypted column. Provide a one-shot `mcp-connector rotate-master-key --new-key-file <path>` command that:
1. Reads the current key (from `CONNECTOR_KEY_FILE` or passphrase).
2. Reads the new key from `--new-key-file` (32-byte file).
3. Decrypts every `*_ct` column into a memory buffer.
4. Re-encrypts every column with the new key.
5. Updates `encryption_meta.key_fingerprint`.

The command is offline (connector process must not be running). No mid-flight re-encryption — the risk of a mid-rotation crash leaving the DB half-sealed isn't worth the complexity. Rotation is a rare event; taking the connector down for a few seconds is acceptable. In Kubernetes: run the rotation as a Job with both old and new secrets mounted, then update the Deployment's secret reference.

**Cross-reference:** the master key here is a *storage-at-rest* concern, distinct from the sealed-box wire encryption in [`CREDS-ENCRYPTION.md`](CREDS-ENCRYPTION.md). Multi-account layers on top of that plan: each controller still seals `creds-response` env values against the connector's ephemeral X25519 public key (minted per-process, published in every tunnel's register frame). The DB master key is used only for at-rest encryption of the bearer/OAuth/registration-token/shared-cred fields. Two keys, two purposes, two lifetimes.

### Encryption primitive

Use libsodium's `crypto_secretbox_easy` (XSalsa20-Poly1305) for at-rest sealing:
- **Nonce:** 24 random bytes prepended to the ciphertext (`BLOB` layout: `nonce || ciphertext`).
- **Key:** the 32-byte master key.
- **Padding:** none — the fields are small (tokens ~40 bytes, OAuth secrets ~40 bytes). No metadata leakage concern.

Rationale: same libsodium primitive family as the wire-side `crypto_box_seal`, no new crypto surface. `crypto_secretbox_easy` is the symmetric variant; sealed-box would be asymmetric overkill here.

### `.env` after migration

After first boot with the new binary and the auto-import path (§"Tunnel process — boot"), the `.env` file is no longer authoritative. To reduce confusion:
- Log a WARN at every boot when the removed per-controller keys (`TUNNEL_AUTH_TOKEN`, `CONTROLLER_URL`, `CONNECTOR_NAME`, `OAUTH_*`) are present in `.env`: `"legacy per-controller env vars ignored; add controllers via inspector at http://localhost:9090/"`.
- Document the source-of-truth clearly in the inspector's "Controllers" page ("this connector's tunnels are configured in the `mcp_connector` schema on Postgres; the `.env` file only carries global connector config").

## Tunnel lifecycle in detail

### N tunnels, one register frame each — differences from single-controller

For each row in `ConfigStore.controllers` where `enabled = 1`:

1. **Instantiate `TunnelClient`** with the row's `controller_url`, `connector_name`, and one of:
   - `authToken: <decrypted plaintext>` for `auth_mode = 'static-bearer'`.
   - `authProvider: OAuthProvider(clientId, decryptedClientSecret, tokenUrl)` for `auth_mode = 'oauth2-cc'`. **One provider per controller** — do not share OAuth providers across tunnels (different token URLs, different scopes).
2. **Dial** — connector opens WSS to `wss://<host>/mcp-tunnel` with headers per CLAUDE.md §"WS-handshake auth". Each tunnel dials independently; a slow-to-connect controller does not block others.
3. **Send register frame** with the per-controller manifest and the connector's global public key. `registrationToken` is null on first-add, present on subsequent boots.
4. **Await register-ack**. On success:
   - Persist any fresh `registrationToken` back to the row.
   - Update `last_connected_at`.
   - Set the tunnel's per-controller coordinators active (`CredsCoordinator.bind`, `McpConfigCoordinator.bind`, `LocalMcpsCoordinator.bind`).
5. **Steady state:** same as today, N-way. Each tunnel independently handles heartbeat / creds / mcp-config / local-mcps-rescan / webhook / mcp-notification / mcp-enable / mcp-disable frames.

### Cross-tunnel coordination — what needs to synchronize?

**Almost nothing.** By design, tunnels are independent event loops sharing only the supervisor. Places where cross-tunnel awareness matters:

1. **`local-mcps-rescan` from controller X.** Rescanning is a filesystem read + supervisor reconcile. The result affects the shared MCP roster. Controller X gets the ack per today's shape. But **every other connected controller also needs `mcp-discovered` frames** for newly-added drop-ins so they can approve independently. Design: TunnelHub intercepts the rescan-added list from the LocalMcpsCoordinator and fans out `mcp-discovered` to all tunnels (subject to each tunnel's connection state — offline controllers see them on their next register-ack via the standard bootstrap path).
2. **`mcp-enable` / `mcp-disable` for a shared drop-in from controller X.** Only affects X's manifest slice. Emits `manifest-delta` on X's tunnel only. Other tunnels unaffected.
3. **`mcp-config-snapshot` from controller X.** Affects only X's private-scope entries. Emits `manifest-delta` on X's tunnel only. No coordination.
4. **Shared MCP crashes and is restarted by the supervisor.** All controllers that had it in their manifest see a brief `manifest-delta { removed: [name] }` … `manifest-delta { added: [name] }`. Or, if the process comes back cleanly with same tool signatures, no delta at all (existing behavior). The supervisor decides; the hub fans out.
5. **Inspector-driven mutation (add / remove / rotate a controller).** The hub is the mutation point. Adding a new controller: instantiate TunnelClient, dial, follow the boot sequence. Removing: send `goodbye`, close the tunnel, tear down that controller's private-scope supervisor entries, remove from `entries.get(ctrlXId)`. Rotating: replace the row's `authToken`/`oauth_client_secret_ct`, gracefully close the WS with reason `credential-rotated`, immediately redial.

### Registration token — per-controller scoping

Today: one `registrationToken` in `.connector-state.json`. On first connect, the controller mints; on subsequent connects, the connector presents it.

Multi-account: one `registration_token_ct` per row in `controllers`. Each controller mints its own token bound to its own row. Losing token X does not affect token Y.

Clearing tokens for re-mint:
- Today: delete `.connector-state.json`.
- Multi-account: inspector button "Force re-registration" on the controller row, or `UPDATE controllers SET registration_token_ct = NULL WHERE id = ?` via CLI.

### Reconnect semantics — per-tunnel

The auto-reconnect state machine from CLAUDE.md §"Reconnect semantics" runs **per tunnel**. `policy.reconnect` is per-tunnel too — read from the (shared) `connector.yaml` policy block, applied by every TunnelClient. Rationale: one connector's policy for backoff/heartbeat/etc. applies uniformly across all controllers. If per-controller override becomes needed, it's a localized addition (add a `policy_override_json` column to `controllers`).

`registrationRejected` flag is per-tunnel: rejection from controller A does not disable auto-reconnect for B. Inspector surfaces the flag on A's tab only.

## RPC routing & manifest scoping

### Manifest builder — filtered per controller

Today `buildManifest()` in `packages/connector/src/manifest/build.ts` walks `servers: Map<string, McpServerConnection>` and produces one `ToolManifest`.

Multi-account: `buildManifest(ctrlId, approvedSharedNames: Set<string>)` walks the supervisor entries with the filter:

```
for each Entry in supervisor:
    if entry.owner === "shared" && approvedSharedNames.has(entry.name):
        include
    else if entry.owner === "shared" && entry.status.source in ("yaml", "bundle"):
        include unconditionally (no approval gate)
    else if entry.owner === ctrlId:
        include
    else:
        skip (this is another controller's private MCP)
```

The `manifest-delta` builder does the same filter, so:
- Approve a drop-in on controller X → delta emitted on X's tunnel with `added`.
- Add a Type 2 on controller Y → delta emitted on Y's tunnel with `added`.
- Neither delta reaches the other controllers.

### RPC dispatcher — the visibility gate

Today, the dispatcher receives `tools/call` with `params.name = "${server}.${tool}"`, splits, and looks up in the flat `servers` Map.

Multi-account:

```
onRpc(ctrlId, frame):
    (server, tool) = split(frame.params.name, ".")
    // Private scope wins if present; otherwise fall through to shared.
    // Cross-scope collisions are impossible by the push-time rejection rule.
    entry = supervisor.entries.get(ctrlId)?.get(server)
         ?? supervisor.entries.get("shared")?.get(server)
    if entry === undefined:
        return jsonRpcError(-32601, "method not found")

    // Visibility gate — enforce N1
    if entry.owner === "shared":
        if entry.status.source === "local"
           && !approvedSharedNames(ctrlId).has(server):
            return jsonRpcError(-32601, "method not found")   // gate hides existence
    else if entry.owner !== ctrlId:
        return jsonRpcError(-32601, "method not found")       // defense-in-depth; shouldn't reach here

    return entry.connection.callTool(server, tool, frame.params.arguments)
```

The `-32601` return for gated / other-controller MCPs is deliberate — same code the SDK returns for a truly-unknown method. Do NOT differentiate to preserve the property that controller B cannot enumerate controller A's private MCPs by probe.

### Non-`tools/call` methods (v1.2 extensions)

`prompts/*`, `resources/*`, `completion/complete`, `logging/setLevel` route the same way — each carries either an implicit qualifier (`${server}.${name}`) or an explicit `params.serverName`. The dispatcher applies the same visibility gate before calling through to the underlying `McpServerConnection`. Aggregate `*/list` methods (with no serverName) enumerate only the caller's visible slice.

`mcp-notification` frames flowing controller-ward (server-initiated notifications from an MCP child) fan out only to controllers with the source MCP in their visible manifest. A `notifications/tools/list_changed` from a controller-X-private MCP goes only to X's tunnel; from a shared+approved MCP, to every controller that has it approved.

## Creds precedence in multi-controller world

Today's precedence, per CLAUDE.md §"Per-entry env precedence":
```
process.env ⊕ spec.env (yaml inline + dir/.env) ⊕ sessionEnv ⊕ controllerEnv
```
(⊕ = merge, right wins on conflict.)

Multi-account extends this with the ownership scope of the entry. The precedence rules split by scope:

### Private (Type 2) MCP owned by controller X

The env is built when the supervisor spawns/restarts this entry. Only X can inject creds via the wire. Precedence:
```
process.env ⊕ spec.env (yaml inline + dir/.env — usually empty for Type 2) ⊕ sessionEnv[X] ⊕ controllerEnv[X]
```

- **`controllerEnv[X]`** — creds pushed by controller X via `creds-response` / `creds-update`. Other controllers cannot inject here.
- **`sessionEnv[X]`** — operator-pasted via inspector while viewing X's tab (see §"Session creds & shared MCPs" for why we scope this per-controller, not global).
- **No cross-controller leakage:** controller Y's `controllerEnv[Y]` map is not consulted for controller X's private MCPs.

### Shared MCP (Type 1 drop-in, Type 1 yaml, Type 3)

No single controller owns it. Precedence stays as it is today, single-controller:
```
process.env ⊕ spec.env (yaml inline + dir/.env) ⊕ sessionEnv[shared]
```

Two important properties (Q4 resolution):
- **`controllerEnv[*]` is NOT in this chain.** A shared MCP does not consume creds from any controller. Rationale: the "shared" scope means "no controller-side authority defines this MCP's runtime state." If a controller wants creds to flow, it should push the MCP as Type 2 instead of relying on the shared-drop-in path.
- **No connector-side DB layer for shared MCP creds.** `dir/.env` on the connector filesystem is the source of truth. Customer edits the file (via git commit + image rebuild, or a mounted-volume filesystem drop) and restarts / rescans. This preserves the "customer owns shared MCPs" property and avoids introducing a secondary paste-into-inspector UX for something already covered.

The single deviation from single-controller precedence: `sessionEnv` is scoped `[shared]` here (not global), matching the scope of the entry itself. See §"Session creds & shared MCPs".

### Session creds & shared MCPs

Today's session-creds path (`POST /mcp/session-creds-apply`) is loopback-only, in-memory, write-only on the wire. Multi-account keeps every one of those properties.

Two subtle points on scoping:
- **When the operator pastes session creds while viewing controller X's tab for a Type 2 MCP:** value lands in `entry.sessionEnv[X]`. Applies only to X's private entry. Other controllers' entries — including their identically-named Type 2s — are unaffected.
- **When the operator pastes session creds while viewing the "Shared" tab for a shared MCP:** value lands in `entry.sessionEnv["shared"]`. Applies to the one shared entry. Every controller consuming it via `tools/call` gets the same runtime env.

The TTL is per-scope: the 12h timer clears whichever sessionEnv slot was written. Session-creds do not fall through to disk in either scope. This is the ONLY connector-side ephemeral cred surface — for anything persistent, edit `dir/.env` on disk.

### The `creds-request` fan-out is per-controller

At register-ack time today, the CredsCoordinator fans out a `creds-request` for each MCP whose `envKeys` union is non-empty. In multi-account, this fan-out is per-tunnel:

- **Controller X's tunnel comes up.** X's CredsCoordinator sends `creds-request` for each **private-scope entry owned by X** whose envKeys are non-empty. It does NOT send requests for shared MCPs (they're not X's to configure) or for other controllers' private MCPs (X can't see them).
- **Late `creds-response` arrival for X's private MCP** — applied via `supervisor.applyControllerEnv(name, env, source="controller-response", reason="late-response")` scoped to X.
- **`creds-update` push from X** for a shared MCP → **rejected** at the frame handler (log and drop; the MCP name doesn't resolve within X's scope). See §"Wire protocol changes" for whether an explicit ack frame carries the error back.

### Env-source telemetry

The existing per-spawn `mcp spawn env-sources` log stays valuable. It now carries:
- `owner: "shared" | ctrlId`
- `controller: [...]` (env keys from `controllerEnv[owner]`, empty for shared)
- `dirDotEnv: [...]`
- `session: [...]`

Watch `dirDotEnv` on shared MCPs stay the norm (that's where customer creds live for shared surfaces), and watch `controller` grow as customers push more Type 2 MCPs — same "D2 deprecation tracker" spirit, per-scope.

## Approval gate under multi-controller

CLAUDE.md today: "Approval state lives controller-only (replayed via `mcp-enable` on every `register-ack`; connector keeps no approval persistence)."

Multi-account preserves this exactly, per-controller:

### Approval semantics
- **Predicate is unchanged:** `entry.owner === "shared" && entry.status.source === "local"`. Type 1 yaml, Type 3 bundles, and Type 2 controller-pushed MCPs are NOT gated. Only Type 1 drop-ins.
- **Approval scope becomes `(controller_id, mcp_name)`.** Each controller has its own approval store on its side.
- **Connector-side approval RAM shape:** `approvedByController: Map<ControllerId, Set<McpName>>`. This map is populated by:
  - `mcp-enable { mcp }` frames from that controller.
  - Replayed on every `register-ack` from that controller (existing CLAUDE.md rule).
  - Cleared when the controller row is deleted from the DB (all of that controller's approvals go away — same as removing the controller's manifest access).
- **Cleared on WS reconnect BEFORE register-ack?** No — the map for controller X is not cleared on `close`; only replaced on the next `register-ack` (which arrives with a burst of `mcp-enable` replays). This preserves approval state across brief tunnel flaps.

### Frames emitted at boot

For each shared drop-in (`entry.owner === "shared" && entry.status.source === "local"`):
- **At every register-ack for controller X**, emit `mcp-discovered { mcp, author: "customer", source: "local", envKeys, tools }` if `!approvedByController.get(X)?.has(mcp)`. This tells X's controller UI "there's a proposed drop-in you haven't approved yet."
- Once X sends `mcp-enable { mcp }`, the connector adds the tools to X's manifest via `manifest-delta` and emits `mcp-enable-ack`.

For each shared drop-in added by a W-L2 rescan **while multiple controllers are connected**:
- The TunnelHub fans out `mcp-discovered` to every currently-connected controller. Each independently decides.
- Boot-connected but currently-offline controllers pick it up on their next register-ack (the standard replay path).

### Concurrency — two controllers approving the same drop-in in the same tick

Race window between `mcp-enable` from A and `mcp-enable` from B for the same shared MCP. Neither changes the other's state. Both succeed. `mcp-enable-ack` goes to each independently. `manifest-delta` goes to each independently. The shared MCP entry does not restart.

### Concurrency — approval flip while a `tools/call` from the same controller is in flight

Not a race we need to protect against — the RPC dispatcher enforces the visibility gate on each frame. If the operator revokes approval on controller X's side (via `mcp-disable`), the next `tools/call` from X will fail the gate. In-flight calls that had already been dispatched to the child process complete and return their response — the child doesn't know or care. Same behavior as today's single-controller `mcp-disable`.

## Webhooks in multi-controller world

The webhook design in `CLAUDE.md` §"Webhook ingress preserves the outbound-only invariant": public URL is on the controller, connector consumes as `webhook` frames over the existing tunnel, per-(connectorId, mcp) bcrypt secret, allocated via `webhook-allocate`.

Multi-account key: **webhooks scope to `(controller_id, mcp_name)`, not just `mcp_name`.**

### Design choices

1. **Type 2 (private) MCPs — the trivial case.** Only the owning controller X can `webhook-allocate` for its private Type 2. The controller mints the URL against its own domain; the connector routes inbound `webhook` frames to the (X, mcp) tuple in the webhook registry, which forwards to the MCP child via the existing SDK IPC route. Each private Type 2 can have at most one active allocation, owned by X. Removing the controller row = tearing down the allocation.
2. **Shared MCPs (Type 1 yaml, Type 3, approved-for-me drop-ins) — the interesting case.** Two options:
   - **(2a) One allocation total per shared MCP, first-controller-wins.** If A allocates first, B's subsequent `webhook-allocate` for the same shared MCP returns `webhook-allocate-ack { error: "already_allocated_by_another_controller" }`. Simple, avoids ambiguity.
   - **(2b) Per-controller allocations.** Each approving controller can mint its own webhook URL against the same shared MCP. The connector receives N `webhook` frames (one per controller with an active alloc) for what's really the same upstream event — the customer's upstream (Twilio Console, etc.) configures ONE controller's URL, so in practice only one is active anyway.
   - **Recommendation: (2a).** Cleaner, avoids duplicate delivery. If a customer really wants webhook delivery on both controllers, that's a controller-side fanout concern (both controllers could subscribe to the same upstream event via their own webhook URLs pointed at the same MCP — but that's a policy choice for that customer's controllers, not the connector's).
3. **`webhook-revoke` from controller X for a shared MCP** — allowed only if X owns the current allocation. Otherwise `error: "not_allocation_owner"`.
4. **`webhook-revoke` on controller-X row deletion** — the hub explicitly revokes every allocation owned by X before tearing down the tunnel (implicit close-of-WS revoke is per today's semantics, but explicit revoke lets the controller UI show a clean state).

### Registry shape

Today:
```
webhookRegistry: Map<mcpName, WebhookAlloc>
```
Multi-account:
```
webhookRegistry: Map<`${ctrlId}::${mcpName}`, WebhookAlloc>
webhookAllocByMcp: Map<mcpName, ctrlId>          // fast-path lookup: does anyone own an alloc for this shared MCP?
```

The second map exists so `webhook-allocate` for a shared MCP by controller B can be rejected in O(1) if A already owns it.

### Inspector — Webhooks panel

Per-controller Webhooks panel: shows only that controller's allocations. Plus a "Shared webhooks" section that surfaces the current owner of shared-MCP webhooks (informational only — the controller side is where the URL actually lives, this is just for operator debugging).

### Shared MCP receiving multi-account callbacks (Q7 clarification 2026-07-09)

The one-webhook-per-shared-MCP rule doesn't preclude a shared MCP from handling events from multiple Twilio Accounts (or multiple Segment workspaces, etc.). The `webhook` frame carries the full callback `body` with the upstream's routing metadata intact:

```
webhook { mcp, queryParameters, body, headers?, receivedAt }
```

For Twilio-shaped callbacks, `body.AccountSid` is always present (statusCallback, incoming SMS, voice status callbacks all embed it). The MCP process is expected to:
1. Extract `AccountSid` from `body.AccountSid`.
2. Look up the matching Twilio client from an internal map keyed by AccountSid — built from multiple env sets in `dir/.env` (e.g. `TWILIO_AC_1234_TOKEN=…`, `TWILIO_AC_5678_TOKEN=…`).
3. Dispatch to the right handler.

**No wire-protocol change required** — this is a bundle-authoring pattern, not a connector concern. The connector just forwards the body. The pattern is unusual (Twilio MCPs are usually better as Type 2), but the primitive supports it for the shared-with-multi-account niche.

## Inspector — the operator's control plane

The inspector already binds to 127.0.0.1 and hosts operator-critical routes (session creds paste, MCP status, webhook URLs). Multi-account extends the UI. The bind rule and trust boundary are unchanged.

### Navigation model

Top-level tab strip:
```
[ Shared ]  [ twilio-prod ✓ ]  [ partner-x ✓ ]  [ staging ⚠ ]  [ + Add controller ]
```

- **Shared tab** — lists Type 1 yaml + Type 3 + Type 1 drop-ins with a per-tab "Approval matrix" (which controllers have approved each drop-in), shared session-creds panel (ephemeral only — persistent env for shared MCPs lives in `dir/.env` on disk), shared-MCP webhook allocations (informational). Notably absent: any "paste persistent creds" flow — see Q4 in the resolutions log.
- **Per-controller tabs** — one per row in `controllers`. Icon in the tab title reflects connection state (✓ connected, ⏳ connecting/reconnecting, ⚠ closed, ⛔ registrationRejected). Content:
  - Controller summary (URL, name, auth mode, last connect time)
  - Private Type 2 MCP list with status, tools, creds source
  - "Reload creds" per MCP (same as today, scoped to the controller)
  - "Rotate secret" button (see below)
  - Frames panel (frames on THIS controller's tunnel only, filterable)
  - Approvals panel (which shared drop-ins this controller has approved / not)
  - Webhooks panel (this controller's allocations)
  - "Remove controller" button
- **+ Add controller** — modal form: controller URL, connector name, owner hint (optional, e.g. `"twilio-prod-AC1234abc"` — surfaced in collision errors and in the Controllers tab), auth mode (radio: static-bearer / oauth2-cc), token or (clientId + clientSecret + tokenUrl). Submit → row inserted, tunnel dialed, tab appears.

### Cred-material entry flows

**Adding a controller.** Operator pastes bearer or OAuth credentials into the form. Client-side JS sends via `POST /internal/controllers/add`. The server-side handler:
1. Validates the payload shape.
2. Seals the bearer/OAuth-secret with the master key.
3. Inserts a `controllers` row.
4. Instantiates a TunnelClient and dials.
5. Returns 200 with the new row ID.

The pasted plaintext never persists to disk in the clear and never crosses the wire to any controller. The DB write is atomic. If the initial dial fails (401 bearer mismatch, DNS error), the row is deleted and the form re-renders with the error.

**Rotating a bearer.** Operator clicks "Rotate secret" on controller X's tab, pastes the new bearer. Server-side:
1. Seal + persist the new value.
2. Send `goodbye { reason: "credential-rotated" }` on the tunnel, close cleanly.
3. Immediately redial with the new credential.
4. On successful register-ack, log the rotation to `audit_log`.

**Session creds (existing pattern).** Unchanged loopback-only behavior. Scope selector added: "Apply to: [X controller only] [Shared entry]". This is the only creds-related paste path the inspector offers — for persistent shared-MCP creds, edit `dir/.env` on disk (§Q4 resolution).

### Cross-tab audit log

The inspector renders `audit_log` under a footer link. Read-only, filterable by controller / kind. Purpose: after a controller was removed months ago, operators can still see "twilio-prod was disconnected at 2026-05-04T…" without hunting through the process log.

## First-run experience — no legacy import

**Q10 resolution (2026-07-09):** the plan does NOT auto-import `.env` into a controller row. Multi-account is a from-scratch setup — customers configure their tunnels via the inspector, period. This simplifies the boot flow, removes an entire class of "why did my `.env` change take no effect" support questions, and matches the direction the design was heading anyway.

### First boot

```
1. Load global env: LOG_LEVEL, INSPECTOR_PORT, MCP_BASE_PORT,
                    POSTGRES_URL, POSTGRES_SCHEMA,
                    MCP_DROPIN_DIR, CONNECTOR_KEY_FILE.
2. Resolve master key (file → decrypt Postgres columns).
3. Open ConfigStore. Run migrations to create the schema if fresh.
4. Load connector.yaml — mcp_servers[] populate supervisor's "shared" scope.
5. Discover drop-ins under MCP_DROPIN_DIR → "shared" scope entries.
6. Start ALL shared entries (they need no controller context to run).
7. Start the inspector on 127.0.0.1:INSPECTOR_PORT.
8. ConfigStore.controllers.list() → for each enabled row, dial its tunnel.
9. If no controllers configured yet: inspector's Controllers tab renders an
   empty state with a prominent "Add your first controller" CTA. Connector
   process continues running (shared MCPs are reachable via the inspector's
   test-tools panel; nothing dies waiting for a controller).
```

### Adding the first (or Nth) controller

Operator opens the inspector, clicks **Add controller**, fills in:
- Controller URL
- Connector name (goes into `X-Connector-Name` header)
- Owner hint (optional, e.g. `"twilio-prod-AC1234abc"` — surfaced in collision errors and inspector views)
- Auth mode: static-bearer OR OAuth2 client_credentials
- Bearer OR (client_id + client_secret + token_url)

Submit → `POST /internal/controllers/add` (loopback only) → seal secret with master key → insert row → instantiate `TunnelClient` → dial. On first successful register-ack, the returned `registrationToken` is sealed and persisted to the row. Same shape for adding controllers 2..N.

### What `.env` still holds

`.env` no longer contains any per-controller values. Only global connector config:

```
LOG_LEVEL=info
INSPECTOR_PORT=9090
MCP_BASE_PORT=7100
MCP_DROPIN_DIR=./mcp/local

POSTGRES_URL=postgres://user:pass@host:5432/mcp
POSTGRES_SCHEMA=mcp_connector

CONNECTOR_KEY_FILE=/run/secrets/mcp-connector/master.key
```

`TUNNEL_AUTH_TOKEN`, `CONTROLLER_URL`, `CONNECTOR_NAME`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL` are **removed** from `.env.example` and from the connector's boot-time reading. If they're present in an inherited `.env`, they're ignored (with a boot WARN naming them: `"legacy per-controller env vars ignored; add controllers via inspector at http://localhost:9090/"`).

### Yaml survives

`connector.yaml` is not going away. It still owns:
- `policy.*` (heartbeat, reconnect — applied uniformly across tunnels).
- `mcp_servers[]` (shared Type 1 hand-written + Type 3 bundle entries).

The multi-account change: `tunnel.controller_url`, `tunnel.auth_token`, and `tunnel.name` in the yaml are **removed** (or ignored if present, with a boot WARN). Tunnel identity is entirely a DB concern.

### Deployment implications

- **Kubernetes / ECS:** the connector's Postgres connection env (`POSTGRES_URL`) points to the same Postgres service used by `enterprise-knowledge`. That Postgres already runs on a persistent volume for llamaIndex data — the connector's `mcp_connector` schema rides on the same volume. Losing the PV = losing every controller's registration token AND llamaIndex state; every controller re-mints on reconnect (which requires the customer to also delete the corresponding rows on the controller side to avoid dup-name conflicts).
- **Docker Compose / local dev:** Postgres runs alongside the connector (already the case for `enterprise-knowledge`).
- **Master key sourcing on Kubernetes:** `file` mode with a mounted `Secret` at `CONNECTOR_KEY_FILE` is the intended shape (see §"Encryption strategy — master-key sourcing" for the canonical manifest).
- **First-run UX:** the customer's postinstall docs / walkthrough end at "open http://localhost:9090/ and add your first controller" — not at "edit `.env` and paste your bearer."

## Trust boundary matrix — who can do what

| Actor | Read own creds? | Read other ctrl creds? | Enumerate own MCPs? | Enumerate other ctrls' Type 2s? | Invoke own MCPs? | Invoke other ctrls' Type 2s? | Invoke shared (approved)? | Invoke shared (not approved)? | Push creds for own MCPs? | Push creds for shared MCPs? | Approve drop-in for self? | Approve drop-in for other ctrl? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Controller A | ✕ (creds are one-way to it) | ✕ | ✓ | ✕ | ✓ | ✕ (unknown_method) | ✓ | ✕ (unknown_method) | ✓ | ✕ (rejected: `shared_mcp_not_settable`) | ✓ | ✕ |
| Controller B (peer) | (its own scope) | ✕ | ✓ | ✕ | ✓ | ✕ | ✓ | ✕ | ✓ | ✕ | ✓ | ✕ |
| Operator (inspector, localhost) | ✕ (write-only) | ✕ | ✓ all | ✓ all | via "tools/call" test button (rare) | via test button (rare) | via test button | via test button | (paste flow, not RPC) | ✕ (`dir/.env` on disk instead) | ✓ | ✕ (each controller owns its own approvals) |
| Root on connector host | ✓ /proc/pid/environ | ✓ /proc/pid/environ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Anyone with LAN access to connector container | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |

The last two rows encode the invariants already in CLAUDE.md: root on the host beats everything (out of scope by threat model); external LAN never reaches inbound (outbound-only). Multi-account doesn't change those.

The critical cross-controller rows: **B cannot enumerate A's Type 2s, cannot invoke them, cannot push creds for them, cannot approve on A's behalf.** All enforced by the visibility gate + supervisor scope keying + creds-scope enforcement.

## Wire protocol changes

**Backwards-compatibility discipline:** every change below is either (a) a new frame that older controllers can ignore, or (b) an additive field that older controllers ignore per the existing "Frame envelope unknown-fields rule." No breaking changes.

### Register frame — additive fields (optional)

```ts
interface RegisterFrame {
  type: "register";
  manifest: ToolManifest;
  name?: string;
  registrationToken?: string;
  connectorPublicKey?: string;   // per CREDS-ENCRYPTION.md — SHARED across all tunnels of this connector process
  // NEW — multi-account additive fields (v1.4)
  connectorProtocolVersion?: "1.4";
  // Advisory. Older controllers ignore. Newer controllers may use it to decide
  // whether to send multi-account-only frames (none exist today; every new
  // frame in this doc is already covered by the additive rule).
}
```

### `mcp-config-ack` — descriptive collision errors (Q3 + Q3-refinement 2026-07-09)

Per-entry ack payload for `mcp-config-snapshot` / `mcp-config-delta` now carries structured collision detail:

```ts
interface McpConfigAckEntry {
  mcpId: string;
  name: string;
  status: "applied" | "skipped" | "error";
  error?: "name_taken" | "missing_url" | "missing_command" | ...;
  // Fields specific to error = "name_taken":
  takenBy?: "shared" | "your-roster" | "other-controller";
  existingName?: string;      // echoes the colliding name for UI convenience
  existingMcpId?: string;     // present only when takenBy === "your-roster"
  ownerHint?: string;         // present when takenBy === "other-controller" AND that controller has a non-null owner_hint column
                              //   (e.g. "twilio-prod-AC1234abc"). Set by operator at add-time in the inspector.
                              //   Weakens strict N1 opacity, but justified for same-tenant multi-account use.
}
```

The controller-side UI renders the collision reason in the "New 3rd Party MCP" form so the operator retries with a distinct name. Existing `status: "skipped"` values (missing `url` for http, missing `command` for stdio) unchanged — same envelope, different `error` value.

Older controllers that don't know about `takenBy` / `existingName` fields ignore them per the Frame envelope unknown-fields rule and see `status: "skipped"` with an opaque `error` value. Downgrade-safe.

### `webhook-allocate-ack` — add `error` variant for shared-MCP contention

Already carries `error?: string`; multi-account adds concrete values `"already_allocated_by_another_controller"` and `"not_allocation_owner"` for the shared-webhook policy in §"Webhooks."

### `creds-update` — semantics narrow (no wire change required)

Since Q4 resolution: no controller can push env values for a shared MCP. If a controller sends `creds-update { mcp: "<shared-name>", ... }`, the connector's `CredsCoordinator` for that tunnel:
1. Attempts to look up the entry under `entries.get(ctrlId).get(name)` — no hit (shared entries live under scope `"shared"`).
2. Logs a WARN with `{controllerId, mcp, reason: "unknown_or_shared_mcp"}` and drops.

No wire ack today for `creds-update`; the drop is silent from the controller's perspective. If observability becomes an issue, adding an optional `creds-update-ack` frame is a localized future addition. Recommendation: do NOT add it in v1 — the controller has no legitimate reason to push creds-update for a name that isn't in the private roster it just built.

### No new frames strictly required

The N1/N2 invariants (implicit controllerId on every frame, per-scope supervisor keying) are enforced at the connector's frame-handler level — the tunnel that received the frame IS the controllerId. Nothing to add to the wire.

### `mcp-discovered` — add `existingApprovals` hint (optional)

Currently the frame carries `{ mcp, author, source, envKeys, tools, discoveredAt }`. Optionally add `existingApprovals: ControllerId[]` — a list of anonymized/hashed peer-approval indicators. **Reject this optional field:** it would leak whether other controllers exist and how they've decided. Preserving cross-controller opacity is worth more than the marginal UX benefit.

### `mcp-config-snapshot` — `mcpId` is now controller-scoped

Existing behavior: `mcpId` is per-controller (naturally, since each controller mints its own). Multi-account preserves this. The supervisor's internal key remains `(scope=ctrlId, mcp_name)`; the `mcpId` is stored in `entry.status.mcpId` and threaded into `creds-request` for correlation on the controller side.

Cross-controller collision on `mcpId`: not possible in practice (each controller mints its own namespace), but if a badly-behaved controller happened to reuse another controller's `mcpId` value, the connector's supervisor still separates entries by scope, so no runtime confusion. The `mcpId` is a per-controller-namespace identifier, not a global one.

## Open questions

| # | Question | Current thinking | Blocked on |
|---|---|---|---|
| ~~Q1~~ | **Master-key source default?** | ✅ **Resolved 2026-07-08:** `file` (Docker / K8s Secret mount) is the default. `passphrase-kdf` retained as portable fallback. `os-keychain` dropped. See §"Encryption strategy — master-key sourcing." | — |
| ~~Q2~~ | **DB engine?** | ✅ **Resolved 2026-07-09:** Postgres, reusing the instance already deployed for the `enterprise-knowledge` bundle. Schema `mcp_connector` isolates the connector's tables from llamaIndex. See §"Why Postgres." | — |
| ~~Q3~~ | **Name-collision rule** — private-scope entry with the same name as a shared one? | ✅ **Resolved 2026-07-08:** collision rejected at push time via `mcp-config-ack { perMcp: [{status: "skipped", error: "name_collides_with_shared"}] }`. Shadowing removed. See §"Component architecture > Supervisor keying" and §"Wire protocol changes." | — |
| ~~Q4~~ | **Shared MCPs consuming controller-supplied creds?** | ✅ **Resolved 2026-07-08:** no. Shared MCP runtime env stays in `dir/.env` on the connector filesystem. The DB stores tunnel creds only; there is no `shared_mcp_creds` table and no inspector "paste shared creds" flow. See §"Creds precedence in multi-controller world." | — |
| Q5 | **Ack `creds-update` for observability?** Today `creds-update` is fire-and-forget. | Skip. Since Q4 makes shared-MCP writes structurally impossible from the controller side, there's no legitimate mismatch scenario an ack would surface. Log-and-drop is enough. Reopen only if observability data says otherwise. | — |
| Q6 | **Where do W-L2 rescans originate in multi-controller?** Any controller can trigger. Rescan results are shared. | Confirmed — any tunnel can send `local-mcps-rescan`; hub fans out `mcp-discovered` to every tunnel. | Nothing. |
| Q7 | **Per-tunnel rate limiting?** One controller could spam frames and starve others. | Not in scope for v1. Add token buckets per tunnel if it becomes a real problem. | Real-world signal. |
| Q8 | **Approval matrix UX for the operator.** How do we visualize which controllers have approved which drop-ins? | Grid: rows = drop-ins, cols = controllers, cells = ✓ / — / ⚠(mismatched envKeys). | Wireframe iteration. |
| Q9 | **Bulk operations on controllers.** Add multiple controllers from a YAML? Import from a `controllers.d/` directory? | Reject. Explicit one-at-a-time via inspector. Prevents accidental bulk misconfig. | Nothing. |
| Q10 | **Distinct connector public keys per tunnel** (for wire encryption)? | Reject — per CREDS-ENCRYPTION.md, keypair is per-process (in-memory only, minted once at boot). Sharing across tunnels is fine because the private half never leaves the connector. Per-tunnel keys would triple the ceremony without a threat model to close. | Nothing. |
| Q11 | **Should the connector expose a health-per-controller endpoint** for orchestrator probes? | `GET /health` on the inspector loopback today returns overall status. Add `GET /health/controllers/:id` returning that controller's state. Loopback-only, no auth (matches the rest of the inspector). | Whether orchestrators actually want per-controller health signals — usually they only care about "process alive." |
| Q12 | **Handling of `mcp-notification` fanout for shared MCPs when subscribers disagree.** If A subscribed to `resources/updated` for a shared MCP but B has not subscribed, does the notification go to both? | Route to every controller with the source MCP in its visible manifest AND that has subscribed (subscriptions are tracked per (ctrlId, resource)). | Existing subscription tracking is per-controller in the SDK; needs a check that this survives the multi-account shape. |

## Rollout phases

Sequenced so each phase is independently deployable and testable. No phase blocks daily development against the current single-controller shape.

### Phase 1 — ConfigStore + inspector "Add controller" flow

- Introduce `ConfigStore` (Postgres via `pg` + libsodium `crypto_secretbox_easy` for app-side sealing + `node-pg-migrate` for schema migrations).
- Master-key resolution: `file` source (default) + `passphrase-kdf` (portable/dev fallback). Per Q1 resolution.
- Remove `TUNNEL_AUTH_TOKEN` / `CONTROLLER_URL` / `CONNECTOR_NAME` from `.env` reading path (log-and-ignore if present; §Q10 / Q11 resolutions).
- Inspector's "Controllers" tab: read-only list initially; add the "Add controller" modal in this phase.
- Boot path: for each enabled row in `controllers`, instantiate a `TunnelClient`. Empty-DB case: connector runs with shared MCPs only, inspector shows the empty-state CTA.
- No new frames, no supervisor scope-keying changes yet.
- **Acceptance:** fresh install lands on an empty Controllers tab; operator adds a controller via inspector; that tunnel connects with the same behavior as today's single-controller connector.

### Phase 2 — Supervisor scope keying (still one controller in flight)

- Refactor `McpSupervisor` from `Map<string, Entry>` to `Map<Scope, Map<string, Entry>>`.
- All existing entries land in `scope="shared"` (yaml + drop-ins + bundle) or `scope=primaryControllerId` (Type 2).
- Introduce `entry.status.owner` and thread it through logging / inspector rendering.
- Dispatcher gains a `scope`-aware lookup helper; visibility gate is a pass-through for now (only one controller in flight, everything reachable to everything).
- **Acceptance:** single-controller behavior identical to phase 1, but the internal structure is ready for N.

### Phase 3 — Multi-tunnel plumbing

- `TunnelHub` component: owns N `TunnelClient` instances + N `CredsCoordinator` + N `McpConfigCoordinator` + one shared `LocalMcpsCoordinator` (rescan-fanout logic).
- Per-controller manifest filter (`entriesVisibleTo`).
- Inspector: writable "Controllers" page (add / rotate / remove).
- Wire changes: `connectorProtocolVersion: "1.4"` in register frame (optional).
- **Acceptance:** operator can add a second controller via inspector and see it establish its own tunnel with its own bearer.

### Phase 4 — Per-controller Type 2 rosters

- `McpConfigCoordinator` for controller X pushes into `supervisor.entries.get(ctrlXId)`.
- Visibility gate enforced in RPC dispatcher (N1).
- Manifest emitted to X only includes X's private-scope entries + shared entries approved by X.
- **Acceptance:** two controllers can push independent Type 2 rosters, including the same MCP name in two rows without collision; each sees only its own.

### Phase 5 — Per-controller approvals & webhooks

- `approvedByController: Map<ctrlId, Set<mcpName>>` in TunnelHub.
- `mcp-discovered` fan-out to all controllers on drop-in add / rescan.
- Webhook registry keyed by `(ctrlId, mcp)`; shared-webhook first-controller-wins policy.
- **Acceptance:** approving a shared drop-in on A does not affect B's manifest. Webhook contention returns the expected error.

### Phase 6 — Inspector polish

- Approval-matrix visualization for operator (which controllers approved which shared drop-ins).
- Env-source telemetry surfaced in the inspector's MCP-status panel (per-scope layers).
- Session-creds scope selector in the paste form.
- Frames panel per-tunnel filters.
- **Acceptance:** operator has all the visibility they need to reason about "who sees what" across controllers.

### Phase 7 — Audit log + hardening

- `audit_log` table + inspector renderer.
- Per-controller `/health/controllers/:id` (if Q11 lands positive).
- Rate-limiting per tunnel (if Q7 becomes relevant).
- Master-key rotation command.
- **Acceptance:** all operator actions traceable via inspector; production ops story complete.

## Alternatives considered — and why rejected

### A1 — N containers, one connector per controller

**Shape:** the customer runs one container per (customer, controller) pair. Each container is an unchanged single-controller connector.

**Pros:**
- Zero code change to the connector.
- Perfect isolation (RAM, disk, process) between controllers.
- Failure domain = one controller.

**Cons:**
- Every Type 3 Python venv is duplicated. `enterprise-knowledge` alone is ~200MB — three controllers = 600MB just in venvs, plus Node runtime × 3.
- Every Type 1 drop-in tree is duplicated. Drift is now the customer's problem to prevent (git sync? shared volume? symlinks?).
- Customer operational surface is 3x wider (3 containers to observe, 3 orchestrator specs, 3 volume mounts, 3 config sets).
- Doesn't match the customer ask: "one connector servicing multiple controllers." Multi-account solves it directly; N-containers side-steps the question.

**Verdict:** rejected. Multi-account collapses these costs to near-zero.

### A2 — One connector, N tunnels, but Type 2 MCPs are still global (visible to all controllers)

**Shape:** Type 2 push from controller A adds an MCP to the shared roster; B sees it too.

**Pros:**
- Simpler supervisor keying — flat map preserved.
- Simpler manifest builder.

**Cons:**
- **Violates the trust boundary invariant.** B could now enumerate and call A's MCPs. Even if the customer *intended* both controllers to see each other, this is a policy that lives on the controller side (each controller decides what to advertise) — not something the connector should impose.
- Naming collisions if A and B both push "salesforce" with different definitions — one silently wins.
- Cred confusion: if A pushed creds for "salesforce" and B also pushes, they collide.

**Verdict:** rejected. The private-per-controller shape is the whole point.

### A3 — Persist Type 2 rosters in the DB

**Shape:** connector persists `mcp-config-snapshot` results in a `controller_mcps` table.

**Pros:**
- Faster boot (no wait for the initial snapshot).
- Survives connector restart even if controller is slow to come back.

**Cons:**
- Duplicates authority the controller already has.
- Drift risk when controller-side state changes while connector is offline.
- Adds encryption obligations for another set of fields (Type 2 specs can carry secrets in `env`).

**Verdict:** rejected. Keep the RAM-only shape per CLAUDE.md's `McpConfigCoordinator` design.

### A4 — Config-per-controller YAML files (`controllers.d/foo.yaml`)

**Shape:** each controller registration is a YAML file in a directory; connector reads on boot.

**Pros:**
- Human-inspectable, git-versionable, no DB.
- Boot ordering is simpler (deterministic filename sort).

**Cons:**
- Encrypted-at-rest with YAML means either whole-file encryption (opaque; can't diff) or per-field markers (`token: !encrypted:base64:...`) which are hand-editable footguns.
- Editing a bearer means the operator sees the plaintext in `vim` for the duration of the edit; DB paste flow keeps it in the browser only.
- Bulk-load footgun (see Q9).

**Verdict:** rejected. DB is stronger for secrets. Human-inspectability preserved via `sqlite3` CLI + inspector UI.

### A5 — External secrets manager (AWS Secrets Manager / Vault / etc.)

**Shape:** connector reads controller creds from an external service at boot.

**Pros:**
- Enterprise-grade secret management.
- Centralized rotation.

**Cons:**
- Coupling to a specific cloud / secret system violates the "customer runs one container" pitch.
- Requires network reachability to the secret store at boot — vs. today's self-contained bootstrap.
- Adds a new failure mode (secrets manager unreachable) that has nothing to do with the connector.

**Verdict:** rejected as default. However, the `file` master-key source (mount from AWS Secrets Manager to a file, or from K8s Secret with SecretsStore/CSI driver) lets shops that DO want this integrate cleanly at the OS / orchestrator level. No connector code needed.

### A6 — Controller-side multi-tenancy (one controller instance, N accounts)

**Shape:** solve the problem on the controller side. Twilio's controller offers "sub-account" trees; each sub-account sees only its own MCPs. Customer only needs one tunnel.

**Pros:**
- Zero change to the connector.
- Aligns with Twilio's existing sub-account concept.

**Cons:**
- **Doesn't solve the general case.** Customer wants Twilio-controller + partner-X controller — those aren't on the same controller instance. Twilio can't provide sub-accounts for a partner's platform.
- Blocks any non-Twilio controller.

**Verdict:** rejected as the general solution. Sub-account support on any single controller is a separate concern (and, if a controller offers it, multi-account is orthogonal — one tunnel per controller instance regardless of how many sub-accounts hide behind it).

## Test surface & regression risks

Not exhaustive — a full test catalog lives in [TEST-SUITE.md](TEST-SUITE.md) and will be extended as phases land. Sketch of the multi-account-specific test surface:

### Unit-level (in-package)

- **Supervisor scope keying** — private-scoped entry does not leak into shared enumeration, and vice versa.
- **Manifest filter** — controller X's manifest excludes controller Y's Type 2, excludes unapproved shared drop-ins, includes shared yaml + bundle unconditionally.
- **Dispatcher visibility gate** — `tools/call` from X for Y's Type 2 returns `-32601`, not `"access denied"` (leak prevention).
- **Name-collision rule (global uniqueness)** — controller X pushes Type 2 with a name matching (a) an existing shared entry → ack `takenBy: "shared"`; (b) an entry already in X's own roster → ack `takenBy: "your-roster"` with `existingMcpId`; (c) an entry in another controller's roster → ack `takenBy: "other-controller"` **without** revealing which controller. All rejected; other entries in the same snapshot process normally.
- **Creds precedence** — private Type 2 gets `controllerEnv[owner]`; shared MCP does not consume any `controllerEnv[*]`; shared MCP creds come from `dir/.env` on disk only; session creds scoped correctly (private-per-controller vs shared).
- **Approval RAM shape** — `approvedByController.get(X)` unchanged when Y sends `mcp-enable`; both true after both enable.
- **Config store** — insert/update/delete round-trips; encrypted columns decrypt to originals; empty DB boots cleanly with an empty Controllers tab; legacy `.env` per-controller vars trigger an "ignored" WARN.
- **Master key sources** — passphrase-kdf produces stable key across boots given same passphrase and salt; file source refuses to boot on wrong mode bits.

### Integration-level

- **Two tunnels boot in parallel** — both reach `open` state; each sees only its own manifest.
- **`.env`-migration** — first boot with existing `.env` produces one row; second boot doesn't duplicate.
- **Controller add via inspector** — POST to `/internal/controllers/add`, verify DB row, verify tunnel dial, verify manifest reaches the new controller.
- **Controller remove** — private-scope entries torn down, shared entries untouched, other tunnels unaffected.
- **Bearer rotation via inspector** — old bearer stops working (401 on next dial), new bearer establishes.
- **Approval matrix** — approve on A, verify manifest-delta only on A's tunnel.
- **Shared drop-in rescan while both controllers connected** — `mcp-discovered` on both tunnels.
- **Two controllers push "salesforce" Type 2 simultaneously** — no collision, each sees only its own.
- **Shared-MCP creds paste** — child restarts with new env; other controllers' Type 2 processes unaffected.
- **Session creds cross-scope isolation** — pasting for controller X's private "salesforce" does not affect shared "sample."

### Failure-mode / adversarial

- **Controller B tries `tools/call foo.bar` where foo is A's Type 2** → `-32601`, no leak.
- **Controller B sends `mcp-enable` for a name it doesn't recognize** → `mcp-enable-ack { status: "error", error: "unknown_mcp" }`.
- **Controller B sends `creds-update` for a shared MCP** → dropped, logged, no supervisor mutation.
- **Controller B sends `webhook-allocate` for a shared MCP already owned by A** → `webhook-allocate-ack { error: "already_allocated_by_another_controller" }`.
- **Master key wrong on boot** (passphrase changed / file corrupted) → boot fails fast; DB not modified; log names the key source.
- **DB file permission changed to unreadable mid-life** → subsequent DB writes fail; tunnels continue; error surfaces in inspector.

### Regression tests to add explicitly (from CLAUDE.md's regression-driven catalog)

The following manual-repro scenarios have single-controller pins today. Multi-account extensions must NOT break them:
- **[McpConfigCoordinator lifetime bug 2026-06-21]** — coordinator survives WS reconnect. Multi-account: N coordinators, each survives its own tunnel's reconnect. Test: reconnect A while B is up; A's roster is restored on re-register-ack; B is untouched throughout.
- **[Stdio env flow-through 2026-06-28]** — controller-config stdio MCPs get env via `startEntry`'s merged env, not `connectStdio`. Multi-account: same, per (scope, MCP).
- **[Session-creds leak channels]** — no value read-back anywhere. Multi-account: extend to include per-controller session-cred slots; no read-back from any scope.

## Loose-ends checklist (to resolve before coding starts)

- [x] **Q1** — master-key default → `file` (Docker/K8s Secret), passphrase-kdf fallback.
- [x] **Q3** — private-vs-shared name collision → rejected at push time (`name_collides_with_shared`).
- [x] **Q4** — shared MCPs use `dir/.env` on disk only; no DB layer, no inspector paste flow.
- [x] **Q5** — no `creds-update-ack` frame in v1 (log-and-drop is sufficient given Q4).
- [x] **Q2** — DB engine → Postgres (reuse llamaIndex's instance).
- [x] **Q3-refinement** — name-collision rule tightened to global uniqueness; ack payload made descriptive with `takenBy` field.
- [x] **Q3-refinement-2** — `ownerHint` added to collision ack. Strict cross-controller opacity relaxed for same-tenant multi-account.
- [x] **Q6** — per-controller approval semantics confirmed: shared process regardless, per-controller manifest gate.
- [x] **Q7-refinement** — shared MCP multi-account webhook dispatch handled by bundle inspecting `body.AccountSid`; no wire change.
- [x] **Q10** — legacy `.env` import dropped. New customers configure controllers exclusively via the inspector.
- [x] **Q11** — `CONTROLLER_URL` / `CONNECTOR_NAME` also move to DB (per-controller row); `.env` retains only global config.
- [ ] **Deferred to separate plan: [`EK-LLM-PROVIDER.md`](EK-LLM-PROVIDER.md).** Move `enterprise-knowledge`'s default embedding path from OpenAI onto a **self-hosted Ollama sidecar** — direct port of the controller team's proven `feat/embeddings-self-hosted` design (Ollama service, `nomic-embed-text-v1.5` @ 768-dim, ~$5/mo on Fly). Key clarification from that plan: **the bundle uses only embedding models, not chat LLM** — response synthesis lives on the controller. So the "Anthropic support" ask is really "customer runs Anthropic chat on the controller + picks any embedding provider on the connector" — Ollama removes the whole cross-provider matrix problem by making embeddings self-hosted with zero external egress.
- [ ] **Q8** — approval-matrix UX wireframe.
- [ ] **Q11** — controller-team signal on per-controller health.
- [ ] **Sequence with `CREDS-ENCRYPTION.md`** — that plan is currently deferred. Multi-account CAN ship without it (bearer at rest is the new thing; wire encryption is orthogonal), but the two intersect on the connectorPublicKey field. If CREDS-ENCRYPTION lands first, multi-account inherits it cleanly (one keypair per process, shared across tunnels). If multi-account ships first, register frames carry no `connectorPublicKey`; when CREDS-ENCRYPTION follows, add it globally.
- [ ] **Sequence with drop-in approval gate (v1.3+)** — see `CONTROLLER-HANDOFF-MCP-APPROVAL.md`. Multi-account extends the per-controller approval predicate. If the gate doesn't ship, multi-account still works for Type 2 privacy + shared Type 1/3 access; the per-controller approval story just doesn't exist yet.
- [ ] **Sequence with the controller side.** The controller team needs to know: register frames may now be sent by a connector that ALSO holds a tunnel with a different controller. This is transparent to any single controller — no wire change — but worth flagging so the "connector identity = one row on my controller" mental model stays intact. Also flag the new `mcp-config-ack` error variant `"name_collides_with_shared"` (Q3).

## Viability summary

| Dimension | Verdict |
|---|---|
| Trust model | ✅ Preserves every existing invariant; sharpens I2/I3 to per-controller scoping. |
| Outbound-only invariant | ✅ Preserved. N outbound tunnels, still zero inbound. |
| Connector-core neutrality (no LLM, no doc handling) | ✅ Preserved. Multi-account is plumbing, not policy. |
| Backwards compat | ✅ `.env` bootstrap path; single-controller deployments upgrade transparently. |
| Operational tax on customers who don't need multi-account | 🟢 Near-zero. DB is created on first boot; single-controller shape is unchanged. |
| Operational tax on customers who DO need multi-account | 🟢 Inspector-driven add / rotate / remove. No file editing. |
| Scope of code change | 🟡 Wide-but-shallow. Every top-level component touched, but each surgically. |
| Wire-protocol change | 🟢 Additive only. Older controllers keep working. |
| Test-surface expansion | 🟡 Significant — cross-controller isolation is the core new invariant and needs its own regression tier. |
| Effort estimate (7 phases) | Rough: 2–4 weeks for phases 1–4 (the load-bearing plumbing); 1–2 weeks for phases 5–7 (polish, audit, hardening). Assumes CREDS-ENCRYPTION.md is either landed or explicitly deferred. |
| Risks | 🟢 With Q1/Q3/Q4 resolved, the two biggest ambiguity risks are closed. Remaining risks: (1) Q2 (DB engine) — deferred to coding, low impact either way; (2) approval-matrix UX (Q8) — iteration cost, no correctness risk. |

**Overall: viable.** No load-bearing invariant breaks; the change is broad but each individual mechanic is localized. Phase 1 (ConfigStore + inspector "Add controller" flow) can land under an unused feature flag and get real-world exposure before the multi-tunnel work begins.

---

**End of plan.** Q1, Q3, Q4 resolved 2026-07-08. Next step: sanity-check the ownership model with a concrete customer scenario (Twilio + partner controller, mid-scale customer), close remaining loose ends (Q2 pick, Q8 wireframe, Q11 controller-team check-in), and cut a branch for Phase 1 (ConfigStore + legacy `.env` import).

