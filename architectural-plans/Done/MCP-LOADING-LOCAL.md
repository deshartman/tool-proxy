# MCP-LOADING-LOCAL — Plan

> **Goal.** Finish the "local MCP" track of [Done/MCP-LOADING.md](Done/MCP-LOADING.md). Today the customer-authored Type 1 surface is `tools/*.ts` + `server.ts` + `package.json` + `.env`. After this plan it's **just `tools/*.ts`**. Everything else either lives in the controller (env), is synthesized by the connector at boot (server), or is generated on demand (package.json — only when the tool grows a third-party SDK).
>
> **Why this is a separate plan from MCP-LOADING.md.** That plan landed the *infrastructure* (drop-in scanner at `src/dropin.ts`, synthesized child runtime at `src/sdk/dropin-runner.ts`, creds protocol over WSS, per-tool `envKeys`). What it did NOT do is migrate the existing `mcp/local/sample/` and `mcp/local/crm/` folders onto that infrastructure — they still ship `server.ts` and have entries in `connector.yaml` so the scanner skips them. They were left as the legacy shape for backwards-compat. This plan is the customer-facing follow-on: strip those folders down to bare tools, add a Controller-UI register/refresh flow so a new drop-in surfaces without a connector restart, and clean up the per-tool authoring shape so the developer experience is "drop one file in `tools/`, it lights up everywhere."
>
> **Branch.** `feature/mcp-loading-local` (cut from `main`, do not push).
>
> **Status: code complete 2026-06-22 (connector side, branch `feature/mcp-loading-local`).** All four shipped stages committed: W-L1a (`408d9ae`), W-L1b (`ab0fc5a`), W-L2 (`e76e7c1` — frames + coordinator + inspector route + button + 10 tests), W-L4 (`a6f26c1` — docs). W-L3 (xmcp-style named-export shape) remains optional and deferred per DL3.
>
> **Verified by tests + build only.** Build clean; 48 test files, **202 passing** (10 new in `tests/tunnel/local-mcps-coordinator.test.ts` + 2 in `tests/mcp-supervisor/status-source.test.ts`). Live boot smoke test was attempted in the worktree and surfaced a worktree-local **`connector.yaml` config drift** — the gitignored `connector.yaml` still listed `sample` and `crm` as legacy yaml entries (carried over from the main worktree's copy). The drop-in scanner correctly skipped those folders because the yaml claimed them, then the supervisor tried `tsx server.ts` and failed because we'd deleted `server.ts`. Resolution is a one-time edit by whoever does the merge-to-main: remove the `sample` and `crm` blocks from their `connector.yaml`. The committed `connector.yaml.example` already has those blocks removed (W-L1a). See "What still needs verification" below.
>
> **Controller-side** implementation (the **Refresh local MCPs** button + `local-mcps-rescan` emit) is independent and out of scope for this branch — track separately. The connector ignores controllers that don't speak v1.2 per the unknown-frame rule; the inspector loopback path works without controller-side changes, so the merge can land before the controller catches up.

## What landed (commits on `feature/mcp-loading-local`)

| Commit | Stage | Files | Notes |
|---|---|---|---|
| `408d9ae` | **W-L1a** | `mcp/local/sample/server.ts` (deleted), `mcp/local/sample/package.json` (deleted), `mcp/local/sample/.env.example` (deleted), `packages/connector/connector.yaml.example` (sample + crm entries removed), `packages/connector/src/mcp-supervisor.ts` (`McpStatus.source` extended with `"local"` literal; default-derived from `__dropin` marker), `packages/connector/public/app.js` + `style.css` (green `local` badge, plus the W-L2 button JS — single mixed commit), `packages/connector/tests/mcp-supervisor/status-source.test.ts` (+2 defensive tests) | sample is now a pure drop-in — the four tools (now, slow_echo, uuid, weather) keep working unchanged via the synthesized child runtime |
| `ab0fc5a` | **W-L1b** | `mcp/local/crm/server.ts` (deleted), `mcp/local/crm/package.json` (deleted), `mcp/local/crm/README.md` (rewritten for drop-in shape) | crm is now a pure drop-in. `.env.example` kept as a one-line `MOCK_CUSTOMERS_URL` hint for offline dev — controller-supplied env wins on conflict |
| `e76e7c1` | **W-L2** | `packages/connector/src/tunnel/frames.ts` (+`LocalMcpsRescanFrame` / `LocalMcpsRescanAckFrame`), `docs/MCP-PROTOCOL.md` (v1.2 stanza + version line bump), **NEW** `packages/connector/src/tunnel/local-mcps-coordinator.ts`, `packages/connector/src/boot/lifecycle.ts` (wired the coordinator + frame router branch + `mcpActions.rescanLocal`), `packages/connector/src/inspector/server.ts` (`McpActions.rescanLocal?` field + `/mcp/rescan-local` POST route + `handleRescanLocal`), `packages/connector/public/index.html` (button + status pill in MCP Status section head), **NEW** `packages/connector/tests/tunnel/local-mcps-coordinator.test.ts` (+10 defensive tests) | Single-flight rescan; reconciles by diff against `supervisor.statusList()` filtered to `source === "local"` so yaml + controller-config entries are immune. Per-tunnel `bind({send})` rebind; in-flight flag survives WS reconnect. `onMcpAdded` hook fans out a `creds-request` for fresh MCPs via `mcpActions.reloadCreds` |
| `a6f26c1` | **W-L4** | **NEW** `docs/AUTHOR-LOCAL-MCP.md`, `packages/connector/README.md` ("Author a local MCP (drop-in)" section rewritten + new "Refresh without a restart" section), `CLAUDE.md` (Three MCP integration patterns; topology paragraph; "Adding a new MCP" surfaces; McpStatus.source plumbing notes; new file index entry; v1.2 wire-protocol bullets) | Docs lead with the drop-in shape; legacy hand-written shape preserved as escape hatch |

## What's been verified

- **Build**: `npm run build` clean (TypeScript strict, no warnings affecting build).
- **Tests**: 202 passing across 48 files. New coverage:
  - `tests/tunnel/local-mcps-coordinator.test.ts` (10 tests) — pins single-flight coalescing, source-filtered reconcile (yaml + controller-config immunity), per-folder error isolation, yamlNames priority, onMcpAdded / onApplied hook firing, removed-folder unregistration, change detection.
  - `tests/mcp-supervisor/status-source.test.ts` (+2 tests) — pins `register()` + `registerOne()` defaulting drop-in specs to `source: "local"`.
- **Type / wire-shape contract**: `frames.ts` and `docs/MCP-PROTOCOL.md` agree by inspection; controller team can implement against the doc.

## What still needs verification (before merging to main)

1. **Live connector boot end-to-end.** Once the worktree's `connector.yaml` drift is resolved, boot the connector and confirm:
   - Inspector "MCP Server" panel shows `sample` and `crm` registered with the `local` badge (green pill, third value alongside `yaml` muted pill and `controller-config` blue pill).
   - `tools/list` for `sample` returns 4 tools (now, slow_echo, uuid, weather); `tools/list` for `crm` returns 7 tools (get_customer, get_recent, issue_refund, get_appointment, check_availability, update_appointment, notify_agent). Same counts as before W-L1.
   - Per-spawn `mcp spawn env-sources` log shows `controller: [...]` populated for `crm` when the operator has entered creds in the controller, OR empty + `dirDotEnv: [MOCK_CUSTOMERS_URL]` when falling back to the local `.env`.

2. **Inspector loopback rescan.** With the connector running:
   - Drop a fresh folder `mcp/local/<NEW>/tools/<TOOL>.ts` (one-tool minimal shape per `docs/AUTHOR-LOCAL-MCP.md`).
   - Click **Refresh local MCPs** in the inspector. The status pill should read `+1 added · -0 removed`. The new MCP appears in the MCP Server panel with the `local` badge. `/mcp/rescan-local` returns `{ ok: true, added: [...], ... }`.
   - Delete the folder and click again. Status pill reads `+0 added · -1 removed`. The MCP disappears.
   - Click again with no disk change. Pill reads `no changes`; the supervisor is untouched.

3. **Controller-triggered rescan.** Out of scope until the controller side ships the **Refresh local MCPs** button. When it does:
   - Frame round-trip: controller sends `{ "type": "local-mcps-rescan" }`; connector emits `{ "type": "local-mcps-rescan-ack", added, removed, unchanged, errors }`.
   - Connector path is identical to the inspector path (same `localMcps.rescan()` method); the only divergence is the ack frame on the wire.

4. **Reconnect resilience.** With a drop-in registered, kill the controller-side WS (or stop ngrok). Confirm the connector's auto-reconnect path keeps the drop-in's supervisor entry registered across reconnects (the LocalMcpsCoordinator is process-wide, not per-tunnel, so its single-flight flag and the supervisor's local entries survive WS cycles by design).

5. **Cross-source immunity.** Confirm a `local-mcps-rescan` does NOT touch yaml-listed (bundled Twilio) or controller-config (3rd-party) entries — even if their folder names happen to match a fresh drop-in. The `yamlNames` set is the gate (drop-in scanner skips); for controller-config entries the `source !== "local"` filter is the gate. Pinned by tests, but worth a manual sanity pass.

## Outstanding work flagged in the plan

- **W-L3** (xmcp-style named-export authoring shape) — optional. Skip unless the team explicitly wants the authoring-shape polish. The legacy `Tool` shape stays supported either way.
- **Removing `dir/.env` entirely** — D2 follow-up from the predecessor MCP-LOADING.md plan. Watch the per-spawn `mcp spawn env-sources` log line; once `dirDotEnv: [...]` trends to `[]` across customer deployments, deprecate the second layer of the env merge stack.
- **Auto-watcher** — if a real customer scenario emerges where they want hot-reload (e.g. a tools-author iterating locally), wire chokidar into `localMcps.rescan()`. One-line change at the call site; the coordinator does the rest. Tracked as future work, not a v1.2 deliverable.
- **Static schema introspection** — L3's named-export shape would let `manifest/validate.ts` enforce `outputSchema` at scan time instead of post-spawn. Pull forward when the next outputSchema-related bug surfaces.

## Outstanding work for the merge-to-main pass

- [ ] **Resolve the `connector.yaml` config drift** in the worktree being merged. The committed `connector.yaml.example` no longer references `sample` or `crm` — but each developer's local `connector.yaml` (gitignored) still might. Edit on first boot post-merge to remove those two blocks; the drop-in scanner picks them up automatically.
- [ ] **Run the live-boot smoke test** above before declaring the merge done.
- [ ] **Update `TEST-SUITE.md`** in the main worktree with rows for the new tests (W-L1: `register() defaults drop-in to 'local'`; W-L2: 10 coordinator tests). The plan does NOT modify `TEST-SUITE.md` directly because it lives in the main worktree per the user's standing rule.
- [ ] **Decide whether to keep the plan in `Done/`.** The worktree has it at `.claude/plans/Done/MCP-LOADING-LOCAL.md`. `.claude/` is gitignored; the file is being shipped manually to the main worktree. Mirror to `mcp-shim/.claude/plans/Done/MCP-LOADING-LOCAL.md` so future Claude sessions can find it.
- [ ] **Cross-track on the controller side**: a TODO entry in `AgenticProcedure/.claude/plans/` for the controller's **Refresh local MCPs** button, linking to v1.2 of `docs/MCP-PROTOCOL.md`. Connector code already accepts the frame; controller just needs to emit it. Until then the inspector loopback path is the operator's affordance.
>
> **Self-describing.** A fresh-context Claude reads this file + [Done/MCP-LOADING.md](Done/MCP-LOADING.md) + [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) + [CLAUDE.md](../../CLAUDE.md) and starts work.

## Quickstart — fresh-context resume after /clear

You are resuming from a cleared context. Here is everything you need to start work.

**Where you are:**
- Worktree at `../mcp-shim-mcp-loading-local/` (sibling of `mcp-shim/`), on branch `feature/mcp-loading-local`. Cut from `main` at the SHA recorded in the first commit on this branch.
- This file is at `.claude/plans/MCP-LOADING-LOCAL.md` inside the worktree. The same file does NOT exist on `main` anymore — it was moved here on the worktree's first commit, deliberately, so the plan travels with the branch.
- Standing rule from CLAUDE.md memory: **branch is local-only, do not push to origin**. Only `main` belongs there.

**What this plan is.** A four-workstream migration to make the customer-authored "local MCP" experience just `tools/*.ts` — no `server.ts`, no `package.json`, no `.env`, no `connector.yaml` edit. The infrastructure already shipped in [Done/MCP-LOADING.md](Done/MCP-LOADING.md); this plan migrates `mcp/local/sample/` and `mcp/local/crm/` onto it and adds a controller-UI rescan flow.

**What you should do FIRST, before reading further:**

1. Run `git status` to confirm you're on `feature/mcp-loading-local` and the worktree is clean.
2. Read [Done/MCP-LOADING.md](Done/MCP-LOADING.md) end-to-end. It explains the supervisor, drop-in scanner, creds protocol, and 3rd-party MCP roster — every workstream below builds on those primitives.
3. Read [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) for the wire-format contract. L2 below adds frames to v1.2 of that doc.
4. Read [CLAUDE.md](../../CLAUDE.md) for architectural invariants (outbound-only, per-MCP env isolation, inspector loopback-only). Don't violate these.
5. Read this plan's "Stages" table. Pick the first `not started` stage in ship order. Mark it `in_progress` in the table when you start; flip to `done — <SHA>` when committed.

**Suggested ship order (locked):** W-L1a → W-L1b → W-L2a → W-L2b → W-L2c → W-L4. W-L3 is optional and deferred unless explicitly requested.

**Decisions that are already locked** (DL1–DL8 in this plan, recap):
- DL1: Keep `dir/.env` as fallback (D2 deprecation tracker continues).
- DL2: Don't adopt mcp-framework / xmcp / fastmcp. Our 70-line `dropin-runner.ts` is enough.
- DL3: xmcp-style named-export shape (W-L3) is OPTIONAL — skip unless asked.
- DL4: No fs-watcher. Operator-driven refresh only.
- DL5: Controller-UI button lives on Connector detail → MCPs tab.
- DL6: No new CLI subcommand (`mcp init`). Docs only (W-L4).
- DL7: No rate-limiting on rescan to start.
- DL8: Inspector source badge gets a third value: `local`.

If a decision needs revisiting based on what you find, surface it before coding — don't silently change direction.

**Verification approach for each stage:**
- L1: `./scripts/start-connector.sh` boots cleanly; inspector "MCP Server" panel shows `sample` and `crm` with the new `local` source badge; `tools/list` returns the same tool count as before; per-spawn env-source log shows controller-supplied keys (or empty + `dir/.env` fallback for offline dev).
- L2: With the connector running, dropping a new folder under `mcp/local/<name>/tools/` and clicking the inspector "Refresh local MCPs" button picks it up without restart. Frame round-trips through `local-mcps-rescan` / `local-mcps-rescan-ack`.
- L3 (if pursued): Both authoring shapes work in the same folder (regression test pin).
- L4: README.md no longer shows legacy `server.ts` or `package.json` examples; `docs/AUTHOR-LOCAL-MCP.md` has copy-pasteable steps.

**Standing rules to apply:**
- Pre-merge: update CLAUDE.md + relevant README.md based on what shipped, in the same commit pass that lands the final stage.
- Tests: regression-driven (per [TEST-SUITE.md](TEST-SUITE.md)). Add a catalog row when manual scenarios surface real bugs, not for coverage. Use TS path aliases (`@mcp` / `@connector`) up front in any new test files — never deep `../` chains.
- Long Edit/Write payloads: chunk them across multiple calls; single Write trips the 8192-token output ceiling.
- Branch: stays on `feature/mcp-loading-local`, local only. Don't push.
- Plan upkeep: when a stage finishes, mark its row `done — <commit SHA>` in the Stages table below. When all stages in a workstream are done, add a one-line summary in the workstream section. When the entire plan is complete, move this file to `.claude/plans/Done/MCP-LOADING-LOCAL.md`.

**Cross-tree note.** The controller side (`AgenticProcedure/`) needs matching changes for L2 — a "Refresh local MCPs" button in the connector detail UI and a handler that emits the `local-mcps-rescan` frame. That work is OUT OF SCOPE for this branch. Track it in [AgenticProcedure/.claude/plans/TODO.md](../../../AgenticProcedure/.claude/plans/TODO.md) with a pointer back to this plan.

## Context — what shipped, what's left

The authoring story today, with the boilerplate counted file-by-file:

```
mcp/local/<name>/
├── tools/
│   └── *.ts              ← the only thing the customer actually wrote
├── server.ts             ← 5-line boilerplate. Already synthesized by dropin-runner for folders without it.
├── package.json          ← present in every Type 1 today (sample, crm, twilio bundle). Empty `dependencies` for sample/crm; non-empty only for twilio.
└── .env / .env.example   ← per-MCP creds. Already replaceable by the controller UI via creds-request, but kept as fallback (D2 of the prior plan).
```

The **drop-in scanner already strips two of these three** — see [src/dropin.ts:55–67](../../packages/connector/src/dropin.ts) (it skips folders that have `server.ts` OR are referenced from `connector.yaml`). The reason `mcp/local/sample/` and `mcp/local/crm/` still carry full boilerplate is purely convention: they were authored before the scanner existed and we left them as legacy reference. To complete the migration, they need to become drop-ins.

The third file — `package.json` — is an axis the prior plan didn't address. It's there because every Type 1 today has the *option* to grow a third-party SDK locally (kept out of the workspace hoist on purpose — see CLAUDE.md "Workspaces"). For sample/crm it carries no `dependencies` and is essentially identity metadata. We can make it optional.

The **controller side has a hole**: today the controller learns about local MCPs only from the *register* manifest. There's no "this customer just dropped a new folder, surface it in the UI right now" affordance — and no way for the operator to ask the connector to rescan without restarting it. The 3rd-party MCP roster (W-E) has both directions covered (controller pushes via `mcp-config-snapshot/delta`); local MCPs are connector-pushed via `register` once and that's it. This plan closes that gap.

## Mental model the customer should have

> Drop a folder under `mcp/local/<name>/tools/` with one or more tool files. That's it. Restart the connector, or click **Refresh local MCPs** in the controller UI, and the connector picks it up, asks the controller for env values, and starts serving the tools.

Everything else is implementation detail we hide:

| Today the customer writes | After this plan |
|---|---|
| `tools/foo.ts` | `tools/foo.ts` |
| `server.ts` (5 lines of boilerplate) | — synthesized by `dropin-runner.ts` |
| `package.json` (identity + optional deps) | — only created when they `npm install <sdk>` |
| `.env` / `.env.example` (per-MCP secrets) | — entered in the controller UI; arrives over the tunnel |
| Edit `connector.yaml` to register the folder | — auto-discovered at boot or on **Refresh** |

## What we're NOT changing

- **Per-folder subprocess isolation.** A misbehaving customer tool still can't crash the connector. Same crash boundary the supervisor enforces today.
- **Per-MCP env isolation.** Cross-MCP env leakage remains impossible. The controller-supplied env still merges per spec, never globally.
- **`.ts`-only authoring.** Python customer drop-ins remain deferred (D3 of the prior plan).
- **The supervisor's role.** This plan adds a discovery / refresh path; it does not change how children are spawned, supervised, or restarted on creds-update.
- **The yaml.** `connector.yaml` keeps `tunnel:` + `policy:` + bundled (Twilio-shipped) entries. Customer-authored local MCPs come *out* of the yaml (they were only there as the legacy registration channel). Type 3 bundled entries stay (different surface — Twilio ships them, customer doesn't author them). 3rd-party Type 2 entries stay where they are (controller-pushed, in-memory roster, not in yaml).

## Workstreams

Four workstreams. Each is independently shippable. The order matters: L1 first (clean up the existing folders so we have a known-good drop-in shape to test against), then L2 (refresh API), then L3 (authoring shape polish), then L4 (`package.json` ergonomics).


### Workstream L1 — Migrate sample/crm to bare drop-in shape

Today both folders look like the legacy Type 1 shape with `server.ts` + `package.json` + `.env.example` + a `connector.yaml` entry pointing at them. The drop-in scanner already exists; it just doesn't activate for these two because every condition in [src/dropin.ts:58–60](../../packages/connector/src/dropin.ts) excludes them.

**The migration, per folder:**

1. Delete `server.ts`. The scanner now matches the folder; `dropin-runner.ts` synthesizes the equivalent at boot.
2. Delete the entry from `packages/connector/connector.yaml` (today's `mcp_servers:` list). The yaml-name guard in the scanner stops excluding the folder.
3. Delete `.env` and `.env.example` if the folder doesn't need any local-dev fallback creds. For folders that do (e.g. `crm` reads `MOCK_CUSTOMERS_URL`), leave a short `.env.example` as documentation — the controller UI is now the primary path and the file becomes a comment-only "if you want to test offline, copy this to `.env`" note.
4. **`package.json` decision per folder:**
   - `sample/` — no third-party SDKs, no `dependencies`. Delete it. Scanner doesn't care; framework deps (`zod`, `@mcp-shim/connector/sdk`) resolve to the workspace root via Node's parent-dir walk.
   - `crm/` — same shape today. Delete it.
   - `twilio/` (bundled, not in scope of L1 but called out for clarity) — keeps its `package.json` because it ships the `twilio` SDK locally. This is the case L4 documents as "the only reason to author a `package.json` is when you've grown a third-party SDK".

**After L1, the on-disk shape is:**

```
mcp/local/
├── sample/
│   └── tools/
│       ├── now.ts
│       ├── slow-echo.ts
│       ├── uuid.ts
│       └── weather.ts
└── crm/
    ├── tools/
    │   ├── check-availability.ts
    │   ├── get-appointment.ts
    │   ├── get-customer.ts
    │   ├── get-recent.ts
    │   ├── issue-refund.ts
    │   ├── notify-agent.ts
    │   └── update-appointment.ts
    └── .env.example   ← optional, keeps the MOCK_CUSTOMERS_URL hint for offline dev
```

`package.json` is gone from both. `server.ts` is gone from both. `connector.yaml` no longer mentions either by name.

**Verification:**

- `./scripts/start-connector.sh` still boots. Inspector "MCP Server" panel shows `sample` and `crm` as drop-ins (existing source badge from W-E6 already discriminates `yaml` vs `controller-config`; this adds a third value — see L3 below for the badge change).
- `tools/list` for both servers returns the same set of tools as today.
- Controller's `creds-request` for `crm` returns `MOCK_CUSTOMERS_URL` (or empty if the operator hasn't entered it); the existing `dir/.env` fallback covers offline dev for now (D2 deprecation tracker keeps watching).

**Risk: Twilio MCP gets accidentally swept up.** The scanner walks `${MCP_DROPIN_DIR}` which today's `start-connector.sh` exports as `mcp/local/`. The Twilio bundle lives at `mcp/bundled/twilio/`, NOT under `mcp/local/`, so the scanner doesn't see it. No risk — but call this out in the docs so a future move/rename doesn't accidentally pull a bundled MCP into the drop-in path.

### Workstream L2 — Controller-UI **Refresh local MCPs** action

Today the connector scans `${MCP_DROPIN_DIR}` exactly once at boot (in `boot/lifecycle.ts`'s startup path). If the customer drops a new folder while the connector is running, nothing happens until restart. We close that with a **connector → controller-pushed rescan trigger**.

**Three additions, all reusing existing primitives:**

1. **New frame: `local-mcps-rescan`** (controller → connector). No payload. Direction matches `creds-update` — controller is the operator-action initiator.
2. **Connector-side handler** in `tunnel/client.ts` calls a new `localMcps.rescan()` method on a coordinator analogous to [`mcp-config-coordinator.ts`](../../packages/connector/src/tunnel/mcp-config-coordinator.ts). The coordinator:
   - Re-runs `discoverDropins({yamlNames})`.
   - Diffs against the running supervisor entries (added / removed / changed-spec — same shape as the v1.1 reconciler).
   - For added entries: `supervisor.registerOne(spec, {source: "local-dropin"}) → startOne(name)`, fan out a `creds-request` for that one MCP via `credsCoordinator.requestOne(name)`.
   - For removed entries: `supervisor.unregister(name)`.
   - For changed entries (spec hash differs — e.g. `dir/.env` content changed but the operator wants to re-source from the controller): `supervisor.replaceSpec(name, newSpec)` which restarts the child.
3. **Inspector + manifest already cover the rest** — the new tools show up in `manifest-delta`, the per-MCP status panel auto-renders the new card, the source badge gets a third state.

**Why a frame, not a controller-side HTTP poke at the inspector:** preserves the outbound-only invariant. The controller already has a WS to push frames; reusing it costs nothing. Making the inspector reachable from the controller would break the trust boundary outlined in CLAUDE.md ("Inspector port is localhost-only").

**Why no auto fs-watcher:** explicitly rejected. Watching `${MCP_DROPIN_DIR}` for changes adds a constant background loop (chokidar etc.), introduces ordering races (file half-written when scan fires), and would silently retry imports of broken tool files. Operator-driven refresh is one button, deterministic, and cheap. If a future customer scenario justifies an auto-watcher, the same coordinator method is the entry point — just call it from a watcher instead of a frame handler.

**Frame schema (added to v1.1 of [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)):**

```ts
// controller → connector
interface LocalMcpsRescanFrame {
  type: "local-mcps-rescan";
  // No fields. The connector decides what's there; controller just triggers.
}

// connector → controller (existing manifest-delta covers the result reporting,
// but we also send a small ack so the operator's UI can show "Done — N added,
// M removed".)
interface LocalMcpsRescanAckFrame {
  type: "local-mcps-rescan-ack";
  added: { name: string; toolsCount: number }[];
  removed: string[];
  unchanged: string[];
  errors: { name: string; error: string }[];
}
```

**Inspector affordance** (in addition to the controller UI button — gives a local-dev path that doesn't need the controller round-trip): a `Refresh local MCPs` button on the MCP Status panel. Loopback only, same trust boundary as everything else there. Calls the same `localMcps.rescan()` method.


### Workstream L3 — Tool authoring shape polish (optional, recommended)

The current `Tool` interface is one default-export object that bundles name + register-callback + optional `envKeys`. It works, but the `register(server)` callback hides the schema declarations *inside* a function body, which makes them hard to extract statically — for example, the connector can't read a tool's `outputSchema` without spawning the child and asking it via `tools/list`.

**Compare** the cleaner shape (inspired by xmcp, but compatible with our SDK):

```ts
// tools/get-customer.ts
import { z } from "zod";
import type { ToolModule } from "@mcp-shim/connector/sdk";

export const schema = {
  customer_phone: z.string().describe("Customer phone number, E.164."),
};

export const metadata = {
  name: "get_customer",
  description: "Returns the customer's identity profile keyed by phone.",
  outputSchema: {
    name: z.string(),
    surname: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  },
  envKeys: ["MOCK_CUSTOMERS_URL"],
} satisfies ToolModule["metadata"];

export default async function execute({ customer_phone }: { customer_phone: string }) {
  // ...handler body
}
```

**What's better about this:**

- Schemas are top-level named exports, so the connector can statically import them at scan time (no need to spawn the child) — useful for boot-time validation, controller-side hydrate-target hints, and the `manifest/validate.ts` outputSchema check that today logs warnings *after* the child starts.
- `envKeys` lives next to the handler that reads them, which makes drift less likely.
- The default-export-is-the-handler shape is the dominant pattern across modern Node frameworks (Next.js routes, xmcp, Vercel functions) — customer muscle memory carries over.

**Decision: do this as an additive shape, keep the old shape working.** `dropin-runner.ts` already has a `pickTool` function that prefers the default export and falls back to the first named export with the right shape. Extending it to also recognize the new triple-export shape is one branch:

```ts
function pickTool(mod: Record<string, unknown>, file: string): Tool | undefined {
  if (isLegacyToolShape(mod.default)) return mod.default;       // today's Tool object
  if (isModuleShape(mod)) return adaptModuleShape(mod, file);   // new triple-export shape
  // ...existing named-export fallback
}
```

`adaptModuleShape` builds a `Tool`-shaped object that calls `server.registerTool(metadata.name, {description, inputSchema: schema, outputSchema}, default)` under the hood. Both shapes route through the same supervisor; nothing else changes.

**Don't make this required.** The four lines of W-L3 work earn their keep on a fresh authoring story (CRM customer writes their first tool from a doc), but breaking the existing 11 tools across `sample/` + `crm/` + `twilio/` would be churn for no win. Document the new shape as the recommended pattern and keep both supported.

**Skip this workstream if** the team feels the legacy `Tool` shape is fine — it's a polish workstream, not a blocker for the L1 + L2 customer experience win. Author this section so a future PR can pick it up cleanly without re-litigating.

### Workstream L4 — `package.json` ergonomics

After L1, neither `sample/` nor `crm/` has a `package.json` — they don't need one. The framework deps (`zod`, `@mcp-shim/connector/sdk`) resolve up to the workspace root.

**The remaining question**: when does a customer *need* to add one? Two scenarios:

1. **They want a third-party SDK in their tool** (e.g. `axios`, `@salesforce/sf-cli`). Today they `npm init -y && npm install axios` inside the folder, which creates `package.json` + `node_modules` locally. The connector's existing first-boot install loop in `scripts/start-connector.sh` covers this case unchanged.

2. **They want to mark their tool as private / set a name / version it.** Identity metadata. Optional today, optional after.

**What L4 ships:** a small CLI helper, `mcp init <name>` (or just clearer docs — see the trade-off below), that:

- Creates `mcp/local/<name>/tools/.gitkeep` (so the directory exists for the customer's first edit).
- Skips creating `package.json` (the file is *not* required).
- Drops a single example tool at `mcp/local/<name>/tools/example.ts` showing the recommended shape.
- Prints next steps: "Edit `tools/example.ts`, then add env vars in the controller UI under Connector → MCPs → \<name>."

**Trade-off:** is a CLI worth the surface area? **Recommendation: NO, just document.** The folder is two files (`tools/example.ts` + an empty marker), and we already have `connector init` which is doing yaml-wizard work that's mostly going away. A single `docs/AUTHOR-LOCAL-MCP.md` page with copy-pasteable examples does the same job at zero connector-side maintenance cost. We can revisit if customers ask for scaffolding.

Result: L4 = a documentation deliverable, not code. Two pages:
- `docs/AUTHOR-LOCAL-MCP.md` — "Create a new local MCP" walkthrough.
- Update `packages/connector/README.md` "Author a Type 1 MCP" section to point at it and remove the legacy `server.ts` + `package.json` example.

## Framework research summary (Node MCP frameworks with auto-discovery)

Asked the question: do `mcp-framework`, `xmcp`, `fastmcp`, or any other Node framework solve the "drop in tools, get a server" problem better than our 70-line `dropin-runner.ts`? Full report ran in a research subagent during this plan's drafting; the short version:

| Framework | Stars | Weekly downloads | Discovery model | Verdict |
|---|---|---|---|---|
| **xmcp** (basementstudio) | 1.3k | 15k | File-scan: `src/tools/<name>.ts` exporting `schema` / `metadata` / default fn | Closest fit. Vercel/Next-flavored deployment story doesn't match our outbound-only WSS-dialer model — adopting means yielding the spawn/transport contract our supervisor owns. |
| **mcp-framework** (QuantGeekDev) | 923 | 61k | File-scan: `tools/`, class extending `MCPTool` with Zod schema + `execute()` | Heavier (class-per-tool), opinionated auth providers we don't need, and adopting forces rewriting every existing customer Type 1. |
| **fastmcp** (punkpeye) | 3.2k | 449k | None — fluent API: `server.addTool({name, description, parameters, execute})` | Doesn't solve auto-discovery. Same boilerplate problem in different syntax. |
| **`@vercel/mcp-adapter`** / `mcp-handler` | — | — | Next.js route helpers | Wrong shape — Next.js, not standalone process. Out of scope. |
| **`@modelcontextprotocol/sdk` (Anthropic)** | — | — | Manual `server.registerTool()` per tool | No auto-registration helpers added since Q4 2025. |

**Decision: don't adopt a framework dependency.** The 70-line `dropin-runner.ts` already does what `mcp-framework` and `xmcp` do for the auto-discovery axis, and crucially does it inside our supervisor's spawn/transport contract (auto-port, env precedence, creds-coordinator, source/mcpId telemetry). Adopting a framework means either wrapping its server inside our spawner — keeping our code AND importing a dep — or yielding the transport to it and re-plumbing creds/headers/auth through their middleware layer. Neither pays off.

**The one idea worth stealing** is xmcp's named-export authoring shape — that's W-L3 above. It's a 20-line addition to `dropin-runner.ts`, not a framework swap.

## Stages

| Stage | Workstream | Delivers | Status |
|---|---|---|---|
| **W-L1a** | L1 | Delete `mcp/local/sample/server.ts` + `package.json` + `.env.example`; remove `sample` entry from `connector.yaml`. Verify drop-in scanner picks it up; inspector renders source badge correctly; `tools/list` returns the four sample tools unchanged. | done — committed on `feature/mcp-loading-local` |
| **W-L1b** | L1 | Delete `mcp/local/crm/server.ts` + `package.json`; trim `.env.example` to a one-line `MOCK_CUSTOMERS_URL` hint; remove `crm` entry from `connector.yaml`. Verify the seven CRM tools all answer; controller `creds-request` for `crm` returns env (or empty + `dir/.env` fallback for offline dev). | done — committed on `feature/mcp-loading-local`; supervisor `McpStatus.source` extended with literal `"local"`, default-derived from the `__dropin` marker so drop-ins render as `local` in the inspector |
| **W-L2a** | L2 | Add `local-mcps-rescan` + `local-mcps-rescan-ack` frame types to `frames.ts`; add v1.2 stanza to `docs/MCP-PROTOCOL.md`. | done — `LocalMcpsRescanFrame` + `LocalMcpsRescanAckFrame` in `src/tunnel/frames.ts`; v1.2 stanza in `docs/MCP-PROTOCOL.md` |
| **W-L2b** | L2 | New `local-mcps-coordinator.ts` with `rescan()` method; reconcile via supervisor `registerOne` / `unregister` / `replaceSpec`; emit ack. Constructed once per process (parallel to `mcp-config-coordinator`'s lifetime — see CLAUDE.md note). Wired into `boot/lifecycle.ts`. | done — `src/tunnel/local-mcps-coordinator.ts`. Single-flight via `rescanInFlight` flag. Reconciles by diff against `supervisor.statusList()` filtered to `source === "local"` (yaml + controller-config entries are immune by design). `bind({send})` per-tunnel rebind; roster + flag survive WS reconnect. `onMcpAdded` hook fans out `creds-request` for new MCPs via `mcpActions.reloadCreds`. 10 defensive tests at `tests/tunnel/local-mcps-coordinator.test.ts`. |
| **W-L2c** | L2 | Inspector "Refresh local MCPs" button on the MCP Status panel; loopback-only POST route `/mcp/rescan-local`. Same trust boundary as the rest of the inspector. | done — button + status pill in the MCP Status section head; `inspector.mcpActions.rescanLocal` wired to `localMcps.rescan()`. POST route under existing 127.0.0.1-only listener. |
| **W-L3a** | L3 | New `ToolModule` interface in `sdk/tool.ts` with `schema` / `metadata` / default fn shape; `dropin-runner.ts` `pickTool` learns to recognize and adapt it. | not started — deferred per DL3 |
| **W-L3b** | L3 | Migrate `sample/` and `crm/` tool files to the new shape as the reference implementation. Twilio bundle stays on legacy shape (Twilio-authored, separate cadence). | not started — deferred per DL3 |
| **W-L4** | L4 | `docs/AUTHOR-LOCAL-MCP.md` walkthrough; update `packages/connector/README.md` to point at it; remove legacy `server.ts` + `package.json` examples from the README. | done — `docs/AUTHOR-LOCAL-MCP.md` shipped; `packages/connector/README.md` "Author a local MCP (drop-in)" section rewritten to lead with drop-in shape and link out to the walkthrough; CLAUDE.md "Three MCP integration patterns" updated. |

**Suggested ship order:** W-L1a → W-L1b → W-L2a → W-L2b → W-L2c → W-L4. Defer W-L3 unless the team explicitly wants the authoring-shape polish.

## Decisions to lock before coding

| # | Question | Recommended | Rationale |
|---|---|---|---|
| **DL1** | Do we still keep `dir/.env` as a fallback after L1? | Yes, for now | Same as D2 of the prior plan. Local dev keeps working without a controller round-trip. The `mcp spawn env-sources` log line tracks deprecation. |
| **DL2** | Adopt xmcp / mcp-framework / fastmcp? | No | Our `dropin-runner.ts` already does what they do; adopting means yielding the spawn/transport contract our supervisor owns. See framework research above. |
| **DL3** | Steal xmcp's named-export authoring shape (W-L3)? | Yes, but optional | Cleaner authoring story; old shape stays supported. Skip if it's not the team's priority. |
| **DL4** | Auto fs-watcher on `${MCP_DROPIN_DIR}`? | No | Operator-driven refresh is deterministic. Auto-watcher adds background loops + ordering races; revisit if a real customer scenario justifies it. |
| **DL5** | Where does the controller-side "Refresh" button live in the UI? | Connector detail page → MCPs tab → "Refresh local MCPs" action button | Mirrors the existing 3rd-party MCP CRUD location. Operator's mental model: "I dropped a folder on the connector volume, click this to make the controller see it." |
| **DL6** | New connector CLI subcommand for scaffolding (`mcp init <name>`)? | No | Two files isn't enough surface area to earn a CLI; docs cover it. Revisit if customers ask. |
| **DL7** | Does the rescan frame need rate-limiting / dedup? | No (start) | Operator-triggered, low frequency. Add a 1-second debounce in the coordinator if a clicker happens; not load-bearing today. |
| **DL8** | What should the inspector source badge say for a drop-in MCP? | `local` (third value alongside `yaml` and `controller-config`) | Matches the customer's mental model. The W-E6 badge code path takes a third literal cleanly. |

## Architectural properties this plan preserves

- **Outbound-only invariant.** Rescan is controller → connector via the existing WS. Inspector "Refresh" button is loopback-only. No new inbound port.
- **Per-MCP env isolation.** L1 deletes `.env`/`.env.example` files but the four-layer merge order (`process.env ⊕ dir/.env ⊕ yaml inline ⊕ controller`) is unchanged — we just shrink layer 2 to "empty" for migrated MCPs.
- **Crash isolation.** Drop-ins still spawn per-folder subprocesses via `dropin-runner.ts`. A misbehaving customer tool can't crash the connector.
- **Yaml as source of truth for what's in the image.** Bundled (Twilio Type 1 + Type 3) entries stay in yaml — they're shipped in the image. Customer-authored locals come *out* of yaml after L1; their source of truth is the filesystem (folders under `${MCP_DROPIN_DIR}`) plus the controller's per-MCP creds rows.

## Test-suite hooks

Cross-refs into [TEST-SUITE.md](TEST-SUITE.md):

- **L1 regression.** New row in the catalog: "drop-in scanner picks up sample/crm after legacy boilerplate removal" — pin the manifest output (tool count + names) so a future scanner change doesn't silently drop tools.
- **L2 coverage.** Phase 4b extension: rescan adds a new MCP at runtime → supervisor spawns it + creds-coordinator fans out a `creds-request` for it. Rescan removes a folder → supervisor unregisters it + emits manifest-delta. Rescan with no changes → ack lists everything as `unchanged`.
- **L2 frame round-trip.** New frame types serialize cleanly; older controller (v1.1) doesn't know `local-mcps-rescan` so it never sends one — connector's behavior is unchanged. Older connector (no L2) ignores `local-mcps-rescan` per the unknown-frame rule.
- **L3 authoring shape.** Pin both shapes work side-by-side: a folder with one legacy-shape tool + one new-shape tool registers both correctly.

## Cross-references

- [Done/MCP-LOADING.md](Done/MCP-LOADING.md) — predecessor plan. W-A (drop-in discovery), W-B (supervisor), W-C (creds protocol), W-E (3rd-party roster) all already shipped.
- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire-format contract. L2 adds `local-mcps-rescan` + `local-mcps-rescan-ack` to v1.2.
- [packages/connector/src/dropin.ts](../../packages/connector/src/dropin.ts) — existing scanner. L2's rescan calls `discoverDropins` again at runtime.
- [packages/connector/src/sdk/dropin-runner.ts](../../packages/connector/src/sdk/dropin-runner.ts) — synthesized child runtime. L3 extends `pickTool` to recognize the new shape.
- [packages/connector/src/tunnel/mcp-config-coordinator.ts](../../packages/connector/src/tunnel/mcp-config-coordinator.ts) — pattern reference for L2's `local-mcps-coordinator.ts` (constructed once per process, rebound per tunnel via `bind()`).
- [packages/connector/src/mcp-supervisor.ts](../../packages/connector/src/mcp-supervisor.ts) — exposes `registerOne` / `startOne` / `replaceSpec` / `unregister` already; L2 reuses them unchanged.
- [packages/connector/src/manifest/validate.ts](../../packages/connector/src/manifest/validate.ts) — outputSchema check. L3's static schema exports could let this run at scan time instead of post-spawn (future enhancement, out of scope here).
- [CLAUDE.md](../../CLAUDE.md) — "Three MCP integration patterns"; "Per-entry env precedence (subtle)" — this plan does not change either, but the customer-visible authoring shape changes meaningfully and CLAUDE.md will need a paragraph update at L1 ship time.

## Future work flagged for later

- **Removing `dir/.env` entirely.** Same as the prior plan's open follow-up. After L1 the `dir/.env` files are gone for `sample` and `crm`; the `twilio` bundle still uses one. Once `mcp spawn env-sources` shows zero `dirDotEnv` keys across all customer deployments, deprecate in a release note and remove the merge layer.
- **Auto-watcher.** If a real customer scenario emerges where they want hot-reload (e.g. a tools-author iterating locally), wire a chokidar watcher into the same `localMcps.rescan()` entry point. One-line change at the call site; the coordinator does the rest.
- **Static schema introspection.** L3's named-export shape lets `manifest/validate.ts` enforce `outputSchema` at boot scan instead of post-spawn. Pull that forward when the next outputSchema-related bug surfaces.
- **Python customer drop-ins.** Still deferred (D3 of the prior plan). The pattern would be a separate scanner that recognizes `pyproject.toml` + `tools/*.py`, spawns via `python -m`, and keeps Type 3 bundle infrastructure. Out of scope — revisit when a customer needs it.
