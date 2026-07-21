# MCP-SHIM-MERGE — merge `feature/mcp-client-use` + `feature/mcp-loading-local` back into `main`

> **Status.** completed 2026-06-22. Integration branch `mcp-shim-merge` carries 13 commits (5 from CLIENT-USE, 4 from LOCAL, 2 merge commits, 2 merge-pass adds: S5 dropin extension + S6.5 ESM migration). 52 files / 223 tests green. S7 boot smoke verified all 4 MCPs spawn (sample with prompts/resources, crm with 7 tools via named-export fallback, apis after creds, enterprise_knowledge). Fast-forward to `main` is S10.
> **Audience.** Whoever does the merge (likely Des). Self-contained for `/clear`'d Claude — read this file, [.claude/plans/MCP-CLIENT-USE.md](MCP-CLIENT-USE.md) §"Parallel-plan coordination", and [.claude/plans/MCP-LOADING-LOCAL.md](MCP-LOADING-LOCAL.md) §"Outstanding work for the merge-to-main pass".
> **Branch.** `mcp-shim-merge` (cut from `main`, do not push — per memory `feature_branches_local_only.md`).
> **Worktree.** Reuse the main checkout at `/Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim/`. The two feature worktrees (`../mcp-shim-mcp-client-use/`, `../mcp-shim-mcp-loading-local/`) stay in place during the merge — they're the source of truth for the resolution decisions if anything looks wrong.

## Why a separate integration branch

Both features shipped on parallel worktrees and never saw each other. The CLIENT-USE plan §"Parallel-plan coordination" calls out three textual conflicts and one functional one. The LOCAL plan flags the merge-to-main pass as the time to resolve the `connector.yaml` config drift and update `TEST-SUITE.md`.

The integration branch lets us:
1. Test the combined surface against the real test suite + smoke before touching `main`.
2. Keep the per-feature branches pristine in case we have to re-cut.
3. Make the resolution commits visible as their own diffs (not buried inside a fast-forward).

When `mcp-shim-merge` is green, fast-forward `main` to it.

## Inputs — what's on each branch

Both branches are sitting on top of the same `main` SHA `3541858` (confirmed: `git log main..feature/mcp-client-use` and `git log main..feature/mcp-loading-local` both show clean linear histories with no shared commits).

**`feature/mcp-client-use`** — 5 commits (`7a69acd → d3deb95`). MCP server-method extension (W-A → W-E):
- Dispatcher widened: `prompts/*`, `resources/*`, `completion/complete`, `logging/setLevel`.
- Manifest extended: `ServerDescriptor.prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities`.
- New SDK author surface: `Prompt` / `Resource` types, `createMcpHttpServer({prompts, resources})`.
- New `mcp-notification` frame + `NotificationForwarder` for server→client notifications.
- Sample MCP gains `prompts/weather-briefing.ts` + `resources/uuids-recent.ts` (worked example).
- Inspector: Prompts + Resources panels.
- Docs: `docs/MCP-PROTOCOL.md` v1.2 §"Server-method extension"; CLAUDE.md + README updates.

**`feature/mcp-loading-local`** — 4 commits (`408d9ae → a6f26c1`). Drop-in migration + rescan trigger (W-L1 → W-L4):
- `mcp/local/sample/` and `mcp/local/crm/` migrate to bare drop-in shape (delete `server.ts` + `package.json`).
- `connector.yaml.example` strips `sample` and `crm` entries.
- `McpStatus.source` gains `"local"` literal; default-derived from the `__dropin` marker.
- New `local-mcps-rescan` / `local-mcps-rescan-ack` frames + `LocalMcpsCoordinator` for controller-triggered rescan.
- Inspector: **Refresh local MCPs** button + `/mcp/rescan-local` POST route.
- Docs: `docs/MCP-PROTOCOL.md` v1.2 §"Local MCPs rescan"; new `docs/AUTHOR-LOCAL-MCP.md`; CLAUDE.md + README updates.

## Conflict surface — what touches the same files

Audited against the two branches' diffs. **One real merge conflict**, three "both append to the same place" textual conflicts, one functional dependency:

| File | CLIENT-USE | LOCAL | Conflict shape |
|---|---|---|---|
| `mcp/local/sample/server.ts` | Adds prompts/resources registration | DELETES the file | **Real conflict** — see resolution below |
| `mcp/local/sample/tools/uuid.ts` | Adds `recordUuid()` call wired to the resource | unchanged | none — LOCAL doesn't touch it |
| `mcp/local/sample/package.json` | unchanged | DELETED | clean — LOCAL wins |
| `mcp/local/sample/.env.example` | unchanged | DELETED | clean — LOCAL wins |
| `mcp/local/crm/server.ts` | unchanged | DELETED | clean — LOCAL wins |
| `mcp/local/crm/package.json` | unchanged | DELETED | clean — LOCAL wins |
| `packages/connector/src/tunnel/frames.ts` | adds `McpNotificationFrame` + grows `ServerDescriptor`/`ManifestDelta` | adds `LocalMcpsRescan(Ack)Frame` | textual — both append to the `TunnelFrame` / `InboundTunnelFrame` unions |
| `packages/connector/src/boot/lifecycle.ts` | wires `NotificationForwarder` | wires `LocalMcpsCoordinator` | textual — both add new imports + new `bind()` calls in `connectTunnel` |
| `packages/connector/src/mcp-supervisor.ts` | adds `onConnect` hook + calls it post-`connectServer` | extends `McpStatus.source` with `"local"`; defaults from `__dropin` | textual — both touch the `register()` body and `SupervisorOpts` |
| `packages/connector/public/app.js` | Prompts + Resources panels | **Refresh local MCPs** button + status pill | textual — different chunks of the same file |
| `packages/connector/public/index.html` | unchanged (panels rendered by JS) | adds button + pill markup | clean — LOCAL wins |
| `docs/MCP-PROTOCOL.md` | adds v1.2 §"Server-method extension" + §"`mcp-notification`" + §"Manifest extension" | adds v1.2 §"Local MCPs rescan" + rewrites the version banner | textual — second-to-merge stitches the v1.2 banner |
| `CLAUDE.md` | adds prompts/resources paragraph + `mcp-notification` to "Wire protocol — frames" | adds drop-in paragraphs + `local-mcps-rescan(-ack)` to "Wire protocol — frames" | textual — different sections; same wire-protocol bullet list |
| `packages/connector/README.md` | adds Prompts/Resources to "Author a Type 1 MCP" | rewrites "Author a local MCP (drop-in)" + adds "Refresh without a restart" | textual — different sections |

**Functional dependency (no textual conflict):** CLIENT-USE adds `mcp/local/sample/prompts/weather-briefing.ts` and `mcp/local/sample/resources/uuids-recent.ts`, and `server.ts` imports them. LOCAL deletes `server.ts` so the prompt + resource files become orphans — the drop-in runner only scans `tools/`, not `prompts/` or `resources/`. **This is the work-list:** extend `dropin-runner.ts` to also scan `prompts/*.ts` and `resources/*.ts` (~30 lines), so the CLIENT-USE worked example survives the migration to drop-in shape. Both plans flagged this as the cleanup; we do it here.

## Decisions to lock before resolving

| # | Question | Locked answer | Rationale |
|---|---|---|---|
| **D1** | Merge order — LOCAL first or CLIENT-USE first? | **LOCAL first**, then CLIENT-USE | LOCAL is smaller, mostly delete-and-rewire. CLIENT-USE's resolution at `mcp/local/sample/server.ts` is "delete it (LOCAL wins) and migrate the prompt/resource registration into the drop-in runner". Same conflict size either order; this order matches both plans' "Recommended merge order" §. |
| **D2** | Where do CLIENT-USE's prompt + resource files live after the migration? | `mcp/local/sample/prompts/weather-briefing.ts` and `mcp/local/sample/resources/uuids-recent.ts` (their CLIENT-USE locations, unchanged) | Drop-in runner gains `prompts/` + `resources/` scanning. Customer authoring shape becomes "drop one file in `tools/`, `prompts/`, or `resources/`" — symmetric. |
| **D3** | Does the drop-in runner extension count as "shipping a feature"? | No — it's the merge-resolution work that both plans flagged | CLIENT-USE plan §"Parallel-plan coordination" §"Recommended merge order" §3 names the ~30-line extension explicitly. LOCAL plan §"Outstanding work flagged in the plan" §"W-L3" calls it out as optional follow-up. We need it now to keep the worked example alive. |
| **D4** | Update `TEST-SUITE.md` in this merge or as a follow-up? | In this merge | Both plans defer it to the merge pass; doing it here keeps the catalog in sync at the moment the tests land on `main`. |
| **D5** | Move plan files to `.claude/plans/Done/` in this merge? | Yes — for both CLIENT-USE and LOCAL | `.claude/` is gitignored, so this is a manual file move on disk. Keeps the two-pass cleanup sequence (write the merged work, then archive) in one PR-ish unit of work. |
| **D6** | Rebase the feature branches first or merge-and-resolve? | **Merge-and-resolve into `mcp-shim-merge`** (no rebase) | Rebasing rewrites SHAs that the plans reference. A merge keeps both feature branches' SHAs in `git log` so the audit trail in the plans stays correct. |
| **D7** | Push `mcp-shim-merge` to origin? | No — per memory `feature_branches_local_only.md` | Only `main` belongs on origin. The fast-forward to `main` after smoke is what gets pushed. |

## Stages

Each stage is a checkpoint. Mark `done — <SHA>` in the table when committed; flip to `verified` after the stage's verification passes.

| # | Stage | Delivers | Status |
|---|---|---|---|
| **S1** | Cut integration branch | `mcp-shim-merge` cut from `main` at `3541858`; baseline tests green (47 files / 190 tests). | **verified 2026-06-22** — branch cut, 47 files / 190 tests green |
| **S2** | Merge LOCAL | `git merge feature/mcp-loading-local` — should be clean (no overlap with main since `3541858`). Resolve worktree-local `connector.yaml` if present. | **done 2026-06-22** — clean merge (no conflicts), 21 files / +951 −152 lines |
| **S3** | Verify LOCAL on integration branch | Build clean; tests pass (target ≥ 200 tests — LOCAL added 12). Boot smoke: drop-in scanner picks up `sample` + `crm`. | **verified 2026-06-22** — build clean, 48 files / 202 tests green (LOCAL +12 on baseline 190, +1 new test file) |
| **S4** | Merge CLIENT-USE | `git merge feature/mcp-client-use` — three textual conflicts + one functional. See §"Resolution recipes". | **done 2026-06-22** — daeb8db. 5 conflicts resolved (R1/R3/R4 explicit; R5/R6 auto-merged); docs banner stitched (R7/R8 partial). Build clean. |
| **S5** | Extend drop-in runner | `dropin-runner.ts` scans `prompts/*.ts` + `resources/*.ts` siblings of `tools/`. ~30 lines + 1 test. | **done 2026-06-22** — runner extended; discovery logic extracted to `dropin-discovery.ts` for testability; 4 new tests in `tests/sdk/dropin-discovery.test.ts` |
| **S6** | Verify combined surface | Build clean; full test suite green (target ≥ 207 tests — CLIENT-USE added 11 + LOCAL added 12 = 213, modulo any test that subsumed an older one). | **verified 2026-06-22** — 52 files / 223 tests green (+33 over baseline 190; CLIENT-USE shipped more tests than planned-for) |
| **S6.5** | ESM migration (unplanned, surfaced at S7 smoke) | Connector flips from CJS-emitted to ESM: `"type": "module"` in `packages/connector/package.json`, `__dirname` → `fileURLToPath(import.meta.url)`, `require.resolve` → `createRequire`. See §"S6.5 — Drop-in CJS-import bug + ESM migration" for the bug repro. | **done 2026-06-22** — 5 source touches, 1 test touch; tests stay 52 files / 223 green; crm drop-in now resolves all 7 tools |
| **S7** | Smoke test combined boot | `./scripts/start-connector.sh` boots; inspector shows sample with `local` badge + Prompts panel renders `weather_briefing` + Resources panel renders `recent_uuids`. | **verified 2026-06-22** — all 4 MCPs spawn (apis 20 tools, crm 7, sample 4+1prompt+1resource, enterprise_knowledge 5); register-ack ok; manifest-delta pushed |
| **S8** | Merge-pass docs sweep | Stitch `docs/MCP-PROTOCOL.md` v1.2 banner; refresh CLAUDE.md "Wire protocol — frames"; refresh README "Author a local MCP"; update `.claude/plans/TEST-SUITE.md`. | **done 2026-06-22** — MCP-PROTOCOL.md banner already stitched in S4; CLAUDE.md dropin-runner / sample / Workspaces (ESM) updated; README "Prompts and resources" + "What it does" refreshed; TEST-SUITE catalog + TESTS_IMPLEMENTED both got merge-pass rows |
| **S9** | Archive plans | Move `MCP-CLIENT-USE.md` and `MCP-LOADING-LOCAL.md` to `.claude/plans/Done/`; mark this plan `Status: completed YYYY-MM-DD`. | **done 2026-06-22** — both archived to `Done/` (LOCAL was already pre-archived; the duplicate copy at `plans/` was rm'd) |
| **S10** | Fast-forward `main` | `git checkout main && git merge --ff-only mcp-shim-merge && git push origin main`. Leave the two feature branches in place per `keep_feature_branches_after_merge.md`. | **done 2026-06-22** — main fast-forwarded `3541858 → 72be9c8`; pushed to origin/main; feature branches + integration branch left in place |

**Suggested ship order (locked):** S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10. Each gates the next.

## Resolution recipes

For each conflict point, the exact resolution. All paths absolute from repo root.

### R1 — `mcp/local/sample/server.ts` (real conflict, S4)

**Conflict:** LOCAL deletes the file (sample → pure drop-in). CLIENT-USE adds `prompts: [weatherBriefing]` + `resources: [uuidsRecent]` to the `createMcpHttpServer` call inside it.

**Resolution:** **Take LOCAL's deletion.** The CLIENT-USE registrations migrate into the drop-in runner via S5 (the runner gains `prompts/` + `resources/` scanning so the existing files at `mcp/local/sample/prompts/weather-briefing.ts` and `mcp/local/sample/resources/uuids-recent.ts` are auto-picked-up).

```bash
# Inside the conflict, both sides:
git rm mcp/local/sample/server.ts
```

The two prompt/resource files from CLIENT-USE land cleanly (LOCAL never touched them) — they need NO edits to work with the extended drop-in runner.

### R2 — `mcp/local/sample/tools/uuid.ts` (no conflict, but verify)

CLIENT-USE adds `import { recordUuid } from "../resources/uuids-recent.js"` and a `recordUuid(data.value)` call inside the handler. LOCAL doesn't touch this file. Merge takes CLIENT-USE's version verbatim. The import path stays valid because S5 keeps `mcp/local/sample/resources/uuids-recent.ts` in place.

### R3 — `packages/connector/src/tunnel/frames.ts` (textual, S4)

**Conflict:** Both branches append discriminants to the `TunnelFrame` and `InboundTunnelFrame` unions.

**Resolution:** Concatenate. Order doesn't matter — TypeScript treats the unions as sets.

```ts
export type TunnelFrame =
  | RegisterFrame
  | ManifestDeltaFrame
  | RpcFrame
  | HeartbeatFrame
  | GoodbyeFrame
  | WebhookAllocateFrame
  | WebhookRevokeFrame
  | CredsRequestFrame
  | McpConfigAckFrame
  | McpConfigResyncFrame
  | LocalMcpsRescanAckFrame    // from LOCAL
  | McpNotificationFrame;      // from CLIENT-USE

export type InboundTunnelFrame =
  | RegisterAckFrame
  | RpcFrame
  | HeartbeatFrame
  | WebhookAllocateAckFrame
  | WebhookFrame
  | CredsResponseFrame
  | CredsUpdateFrame
  | McpConfigSnapshotFrame
  | McpConfigDeltaFrame
  | LocalMcpsRescanFrame;      // from LOCAL
  // (CLIENT-USE adds nothing here — mcp-notification is connector→controller only)
```

The new `interface` blocks above the unions (CLIENT-USE's `PromptDescriptor`/`ResourceDescriptor`/`ServerCapabilitiesAdvert`/`McpNotificationFrame`, LOCAL's `LocalMcpsRescanFrame`/`LocalMcpsRescanAckFrame`) all live in different sections — no edit needed beyond accepting both.

### R4 — `packages/connector/src/boot/lifecycle.ts` (textual, S4)

**Conflict:** Both branches add new imports + new bindings inside `connectTunnel`.

**Resolution:** Take both. Order:

```ts
// Imports — alphabetical-ish, matches existing convention
import { LocalMcpsCoordinator } from "../tunnel/local-mcps-coordinator.js";  // LOCAL
import { McpConfigCoordinator } from "../tunnel/mcp-config-coordinator.js";  // existing
import { NotificationForwarder } from "../tunnel/notification-forwarder.js"; // CLIENT-USE
```

Inside `boot()`:
- LOCAL's `localMcps = new LocalMcpsCoordinator({...})` block goes after the supervisor + before `supervisor.startAll()`.
- CLIENT-USE's `notifications = new NotificationForwarder(log)` goes BEFORE the `new McpSupervisor({...})` call (the supervisor takes `onConnect: (name, conn) => notifications.attachToConnection(name, conn)` in its options — so the forwarder must exist when the supervisor is constructed).
- The `onConnect` hook on the supervisor opts is CLIENT-USE-only; keep it.

Inside `connectTunnel`:
- Both branches add a `bind({send})` call after `mcpConfig.bind(...)`. Append both:
  ```ts
  mcpConfig.bind({ send: (frame) => pendingTunnel.send(frame) });
  localMcps.bind({ send: (frame) => pendingTunnel.send(frame) });       // LOCAL
  notifications.bind({ send: (frame) => pendingTunnel.send(frame) });   // CLIENT-USE
  ```
- CLIENT-USE adds a `notifications.unbind()` call inside `pendingTunnel.onclose` — keep it.

The `frame-router` wiring for `local-mcps-rescan` is LOCAL-side; for the new `inspector.mcpActions.rescanLocal` callback, keep the LOCAL wiring intact.

### R5 — `packages/connector/src/mcp-supervisor.ts` (textual, S4)

**Conflict:** Both branches modify the same struct + register flow.

**Resolution:**
- `McpStatus.source` literal type: take LOCAL's three-value union `"yaml" | "local" | "controller-config"`.
- `register()` body: take LOCAL's `source: isDropinSpec(spec) ? "local" : "yaml"` — `isDropinSpec` is a LOCAL helper that checks the `__dropin` marker.
- `SupervisorOpts.onConnect`: keep CLIENT-USE's optional hook.
- Inside `startEntry` (or wherever `connectServer` is called): keep CLIENT-USE's post-connect call to `this.opts.onConnect?.(spec.name, entry.connection)`.

The two changes don't interact — the source-tagging is at register-time, the onConnect call is at start-time.

### R6 — `packages/connector/public/app.js` (textual, S4)

**Conflict:** Both branches add UI to the same file but in different chunks.

**Resolution:** Take both. CLIENT-USE's Prompts/Resources panels render in the per-MCP detail view; LOCAL's **Refresh local MCPs** button + status pill render in the MCP Status section header. Different render functions; no overlap. If git's three-way merge marks anything, accept both halves verbatim.

### R7 — `docs/MCP-PROTOCOL.md` (textual, S8)

**Conflict:** Both branches bump the version banner to v1.2 with different blurbs.

**Resolution (write in S8 — defer until everything else is green so the doc reflects what actually shipped):**

Use this stitched banner under one v1.2 header:

```markdown
> **Version.** v1.2 — additions covered by the most recent revisions:
> - **v1** baseline: `creds-request`, `creds-response`, `creds-update`.
> - **v1.1**: `mcp-config-snapshot`, `mcp-config-delta`, `mcp-config-ack`, `mcp-config-resync` for controller-driven 3rd-party MCP rosters; optional `mcpId` field on creds frames.
> - **v1.2** (this revision): two additive extensions —
>   - **MCP server-method extension** — widens the dispatcher to forward the full MCP server-method set (prompts / resources incl. templates + subscribe / completions / `logging/setLevel`); adds the `mcp-notification` frame for server→client notifications; manifest grows `prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities` on each `ServerDescriptor`. See §"v1.2 — MCP server-method extension".
>   - **Local MCPs rescan** — adds `local-mcps-rescan` (controller → connector) and `local-mcps-rescan-ack` (connector → controller) for operator-triggered drop-in folder rescans without a connector restart. See §"v1.2 — Local MCPs rescan".
```

Both extensions live as their own §-headers below; both already exist on the respective branches and don't textually conflict with each other. The merge just stitches the version banner.

### R8 — `CLAUDE.md` (textual, S8)

Both branches add to the "Wire protocol — frames" section. Append both bullet sets to the existing list:
- LOCAL: `local-mcps-rescan` + `local-mcps-rescan-ack` bullets.
- CLIENT-USE: `mcp-notification` bullet + paragraph on prompts/resources in the manifest.

The "Three MCP integration patterns" section gets LOCAL's drop-in clarification verbatim. The SDK author surface paragraph gets CLIENT-USE's prompts/resources mention added to it.

### R9 — `packages/connector/README.md` (textual, S8)

LOCAL rewrites "Author a local MCP (drop-in)" to lead with the bare-tools shape; CLIENT-USE adds a "Prompts and resources" subsection. Stitch:
1. Take LOCAL's rewrite as the section's lead.
2. Append CLIENT-USE's "Prompts and resources" subsection at the end of "Author a local MCP (drop-in)".
3. Update the example file layout to show `tools/`, `prompts/`, and `resources/` siblings (matches the S5 runner extension).
4. Keep LOCAL's "Refresh without a restart" subsection.

## S5 detail — extending the drop-in runner

The runner today only scans `tools/*.{ts,js}`. CLIENT-USE adds `prompts/` and `resources/` siblings; LOCAL deletes the hand-written `server.ts` so those siblings need an auto-discovery path. Both plans flagged this as the merge-pass cleanup.

**File to edit:** [packages/connector/src/sdk/dropin-runner.ts](../../packages/connector/src/sdk/dropin-runner.ts).

**Sketch of the change** (target ~30 lines added):

```ts
// existing imports + main()...
import type { Prompt } from "./prompt.js";
import type { Resource } from "./resource.js";

async function main(): Promise<void> {
  const dir = process.env.DROPIN_DIR;
  const name = process.env.DROPIN_NAME;
  // ...existing bail-out guards...

  const tools     = await loadCategory<Tool>(dir,     "tools",     isToolShape,     log);
  const prompts   = await loadCategory<Prompt>(dir,   "prompts",   isPromptShape,   log);
  const resources = await loadCategory<Resource>(dir, "resources", isResourceShape, log);

  if (tools.length === 0 && prompts.length === 0 && resources.length === 0) {
    log.error(`no tools / prompts / resources registered from ${dir} — exiting`);
    process.exit(2);
  }

  await createMcpHttpServer({ name, tools, prompts, resources });
}

async function loadCategory<T>(
  dir: string,
  subdir: "tools" | "prompts" | "resources",
  isShape: (v: unknown) => v is T,
  log: ReturnType<typeof createLogger>,
): Promise<T[]> {
  const path = resolvePath(dir, subdir);
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  const items: T[] = [];
  for (const entry of readdirSync(path).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
    const full = resolvePath(path, entry);
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const picked = pickShape(mod, isShape);
      if (picked) items.push(picked);
      else log.warn({ file: `${subdir}/${entry}` }, `no ${subdir.slice(0, -1)} default-export found — skipping`);
    } catch (err) {
      log.error({ file: `${subdir}/${entry}`, err: err as Error }, `failed to import ${subdir.slice(0, -1)} file`);
    }
  }
  return items;
}

function pickShape<T>(mod: Record<string, unknown>, isShape: (v: unknown) => v is T): T | undefined {
  if (isShape(mod.default)) return mod.default;
  for (const value of Object.values(mod)) if (isShape(value)) return value;
  return undefined;
}

function isPromptShape(v: unknown): v is Prompt {
  return typeof v === "object" && v !== null
    && typeof (v as Prompt).name === "string"
    && typeof (v as Prompt).register === "function";
}

function isResourceShape(v: unknown): v is Resource {
  return typeof v === "object" && v !== null
    && typeof (v as Resource).name === "string"
    && typeof (v as Resource).register === "function";
}
```

**Tests:** add `packages/connector/tests/sdk/dropin-runner-prompts-resources.test.ts` — one test per category that the runner picks up a fixture file. Reuse the existing tools-only test as a template; the categories are symmetric.

**Why this is safe:** the change is purely additive. A drop-in folder with only `tools/` (today's shape) sees the new `loadCategory("prompts")` / `loadCategory("resources")` return `[]`, the factory passes `prompts: []` / `resources: []`, and `createMcpHttpServer` skips the capability advert when both are empty. No regression for existing folders.

**Why this isn't `W-L3` from the LOCAL plan:** L3 was the xmcp-style named-export *authoring shape* — schemas as top-level exports. This S5 work is the much smaller "scan two more sibling folders" change. L3 stays deferred per LOCAL's DL3.

## S6.5 — Drop-in CJS-import bug + ESM migration

The S7 smoke test surfaced a bug that pre-dates this merge (reproduced on `feature/mcp-loading-local` HEAD verbatim, so LOCAL shipped without anyone exercising `mcp/local/crm` in drop-in form): `mcp/local/crm/`'s tools each export the tool object as a NAMED export only — no `export default`. The drop-in runner's `pickShape` is supposed to fall back to scanning named exports, and that path works under tsx when called from a top-level `.cjs` or `.mjs` file. **It does NOT work when the discovery helper is loaded as a CJS dependency** (compiled to `dist/sdk/dropin-discovery.js` and `require()`'d by the equally-CJS `dist/sdk/dropin-runner.js`). In that loader chain the dynamic `import()` of the `.ts` tool file returns a namespace object whose `Object.values()` reports the right entries to a debugger but where the iteration in `pickShape`'s for-loop returns nothing — a tsx CJS-bridge quirk, root-causing it would be a rabbit hole.

**Side-stepping the bridge.** The connector emits CJS today purely because [packages/connector/package.json](../../packages/connector/package.json) doesn't declare `"type": "module"`. With `tsconfig.base.json` already on `module: NodeNext`, adding `"type": "module"` flips emit to ESM with no other config change. Native ESM removes the CJS-vs-ESM dynamic-import bridge entirely; the dropin-runner runs as ESM, the discovery helper is ESM, the dynamic `import()` returns a Module Namespace Object, and `Object.values()` works.

**Scope of the migration** — surveyed before executing:
- Add `"type": "module"` to `packages/connector/package.json`.
- 2× `__dirname` in `packages/connector/src/dropin.ts` (lines 102, 110) → `fileURLToPath(import.meta.url)` + `dirname`.
- 1× `__dirname` in `packages/connector/src/inspector/server.ts` (line 223) → same.
- 1× `require.resolve("tsx/package.json")` in `packages/connector/src/mcp-supervisor.ts` (line 43) → `createRequire(import.meta.url).resolve(...)`.
- 1× dynamic `require("node:fs")` in `packages/connector/tests/tunnel/frame-router.test.ts` (line 202) → top-level `import { writeFileSync } from "node:fs"`.

No source-side import changes needed: `tsconfig.base.json` already has `module: NodeNext` so every relative import already carries the `.js` extension that ESM requires.

**Why this is in the merge, not deferred.** Deferring means S7 stays red and S10 (fast-forward to main) ships a connector where `mcp/local/crm/` doesn't actually load. Either I roll the live yaml back to listing crm explicitly with a `server.ts` (regressing LOCAL's intent), or I fix the underlying CJS bridge issue. ESM is the smaller, more correct change — and matches the user's preference for native modules.



### S1 — baseline
```bash
git checkout main
git pull origin main                 # confirm we're at 3541858 or newer
git checkout -b mcp-shim-merge       # local-only
cd packages/connector && npm test    # baseline: 47 files / 190 tests
```
Pass criterion: **47 files / 190 tests, all green.** If a baseline test is red, stop and investigate before merging anything — main itself has a problem.

### S2 — merge LOCAL
```bash
git merge feature/mcp-loading-local --no-ff -m "Merge feature/mcp-loading-local into mcp-shim-merge"
```
Expected: clean merge. The integration branch was just cut from `main` so there's no overlap. If git reports conflicts, something has drifted — investigate before continuing.

### S3 — verify LOCAL
```bash
cd packages/connector && npm run build && npm test
```
Pass criterion: **48 files / 202 tests, all green** (LOCAL adds 2 new tests in `mcp-supervisor/status-source.test.ts` and 10 in `tunnel/local-mcps-coordinator.test.ts` — total 12 new).

Boot smoke (optional at this stage; required at S7):
```bash
# Edit packages/connector/connector.yaml: remove `sample` and `crm` blocks if present.
./scripts/start-connector.sh
# Inspector at http://localhost:9090 — sample + crm should appear with `local` badge.
# Ctrl-C to stop.
```

### S4 — merge CLIENT-USE
```bash
git merge feature/mcp-client-use --no-ff -m "Merge feature/mcp-client-use into mcp-shim-merge"
# Expect 5 conflicts — see Resolution recipes R1, R3, R4, R5, R6.
# (R2 doesn't conflict; R7/R8/R9 are docs and apply at S8.)
```
Resolve per §"Resolution recipes". After resolution:
```bash
cd packages/connector && npm run build
```
Pass criterion: build clean (TypeScript strict, no warnings). Tests will fail at this point because the sample MCP's prompts/resources are orphaned — that's expected; S5 fixes it.

### S5 — extend drop-in runner
Edit `packages/connector/src/sdk/dropin-runner.ts` per §"S5 detail". Add the new test file. Then:
```bash
cd packages/connector && npm run build && npm test
```
Pass criterion: build clean; new test green; the existing `tests/dispatcher/server-method-passthrough.test.ts` still picks up the sample's prompt + resource via the synthesized runner.

### S6 — full suite
```bash
cd packages/connector && npm test
```
Pass criterion: **target ~213 tests, all green** (CLIENT-USE 11 + LOCAL 12 + S5's new test ≈ 24 new on top of baseline 190). Allow ±2 if a test was renamed or subsumed. Investigate anything red.

### S7 — boot smoke (combined)
```bash
# Confirm connector.yaml has sample/crm REMOVED (drop-in scanner picks them up)
# and apis (Twilio bundle) + enterprise_knowledge entries kept as-is.
./scripts/start-connector.sh
```
Verify in the inspector at http://localhost:9090:
1. **MCP Server panel** — `sample` shows `local` badge (green pill); `crm` shows `local` badge; `apis` shows `yaml` badge (muted).
2. **Available Tools panel** — `sample` lists 4 tools (`now`, `slow_echo`, `uuid`, `weather`); `crm` lists 7 tools.
3. **Prompts panel (NEW)** — `sample` lists 1 prompt (`weather_briefing`).
4. **Resources panel (NEW)** — `sample` lists 1 resource (`recent_uuids`, URI `sample://uuids/recent`).
5. **MCP Status panel** — `sample` and `crm` show `running` with green border.
6. **Refresh local MCPs button (NEW)** — top of MCP Status section. Click with no disk change → pill reads `no changes`.
7. **Frames panel** — `register` frame's manifest carries the new `prompts[]` / `resources[]` / `capabilities` fields for `sample`.

If EK fails to boot (its venv isn't installed in this worktree per the LOCAL plan's note), comment that line out of `connector.yaml` — it's a pre-existing dev-setup requirement, unrelated to this merge.

### S8 — docs sweep
Apply R7, R8, R9 from §"Resolution recipes". Then run [TEST-SUITE.md](TEST-SUITE.md) update — append rows for the new tests:
- LOCAL: `tests/mcp-supervisor/status-source.test.ts` (2 tests, pins drop-in default to `source: "local"`)
- LOCAL: `tests/tunnel/local-mcps-coordinator.test.ts` (10 tests)
- CLIENT-USE: `tests/dispatcher/server-method-passthrough.test.ts` (11 tests)
- CLIENT-USE: `tests/manifest/build-prompts-resources.test.ts`
- CLIENT-USE: `tests/tunnel/notification-forwarder.test.ts`
- S5 (this merge): `tests/sdk/dropin-runner-prompts-resources.test.ts`

Commit message: `Merge: docs + TEST-SUITE catalog for v1.2`.

### S9 — archive plans
```bash
mkdir -p .claude/plans/Done
mv .claude/plans/MCP-CLIENT-USE.md .claude/plans/Done/
mv .claude/plans/MCP-LOADING-LOCAL.md .claude/plans/Done/
# Edit MCP-SHIM-MERGE.md: set Status: completed YYYY-MM-DD at top.
# Optional: move MCP-SHIM-MERGE.md to Done/ too once main has caught up.
```
Note: `.claude/` is gitignored — these moves don't ride a commit. Done.

### S10 — fast-forward `main`
```bash
git checkout main
git merge --ff-only mcp-shim-merge
git push origin main
# Per memory `keep_feature_branches_after_merge.md`: do NOT delete
# feature/mcp-client-use or feature/mcp-loading-local. Leave them in place.
# Per memory `feature_branches_local_only.md`: do NOT push the integration branch.
git worktree remove ../mcp-shim-mcp-client-use      # optional cleanup
git worktree remove ../mcp-shim-mcp-loading-local   # optional cleanup
```

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hidden coupling between `NotificationForwarder` and `LocalMcpsCoordinator` lifecycles | low | Both follow the same construct-once / `bind()` per-tunnel pattern (see CLAUDE.md §"Three MCP integration patterns"). They don't share state; their `bind()` calls are independent. |
| S5 runner extension breaks the existing tools-only flow | low | Purely additive — `loadCategory("prompts")` returning `[]` on a folder without `prompts/` is the existing tools-only behaviour. Pin with regression test. |
| Sample MCP's prompt/resource files use ESM `.js` imports that need adjustment | low | Already use `.js` extensions (TypeScript ESM convention). LOCAL doesn't touch them; they migrate verbatim. |
| `connector.yaml` drift on the merger's machine still has `sample` / `crm` entries | medium | Documented in LOCAL plan §"Outstanding work". The committed `.example` is correct; the gitignored live yaml needs a one-time edit. Smoke test at S7 catches it. |
| EK Python venv missing → boot fails on `enterprise_knowledge` | medium | Pre-existing dev-setup requirement. Comment out the EK entry in `connector.yaml` for the smoke test. Not a merge issue. |
| TEST-SUITE.md row count mismatch | low | Re-count from `npm test` output before writing the rows. Total target is ~213; actual will tell us. |
| Tests that rely on `mcp/local/sample/server.ts` existing | low | Both branches' test suites were green when shipped. The synthesized runtime is what serves sample now; tests use the supervisor path which is identical. |

## Cross-references

- [.claude/plans/MCP-CLIENT-USE.md](MCP-CLIENT-USE.md) §"Parallel-plan coordination — MCP-LOADING-LOCAL" — the original conflict audit, identical to §"Conflict surface" above. Treat the two as a checksum.
- [.claude/plans/MCP-LOADING-LOCAL.md](MCP-LOADING-LOCAL.md) §"Outstanding work for the merge-to-main pass" — the LOCAL-side checklist that S2/S3/S8/S9 pull through.
- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire-format authority; v1.2 banner gets stitched at S8.
- [packages/connector/src/sdk/dropin-runner.ts](../../packages/connector/src/sdk/dropin-runner.ts) — the file S5 extends.
- [.claude/plans/TEST-SUITE.md](TEST-SUITE.md) — catalog row destination for S8.
- Memories: `feature_branches_local_only.md`, `keep_feature_branches_after_merge.md`, `docs_update_before_merge.md`, `chunk_long_docs.md`.

## How to resume from a fresh context

A `/clear`'d Claude resumes this plan by reading exactly four files:

1. **This plan** ([.claude/plans/MCP-SHIM-MERGE.md](MCP-SHIM-MERGE.md)) — design, stages, resolution recipes.
2. [.claude/plans/MCP-CLIENT-USE.md](MCP-CLIENT-USE.md) §"Parallel-plan coordination" — the predecessor's audit.
3. [.claude/plans/MCP-LOADING-LOCAL.md](MCP-LOADING-LOCAL.md) §"Outstanding work for the merge-to-main pass" — the LOCAL-side checklist.
4. [CLAUDE.md](../../CLAUDE.md) — load-bearing architectural properties; "Wire protocol — frames" + "Workspaces" + "Three MCP integration patterns".

### First moves

```bash
# Confirm we're in the right worktree (main checkout)
pwd  # should print: /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim
git rev-parse --abbrev-ref HEAD  # should print: main (or mcp-shim-merge if S1 already done)

# Confirm the two source branches exist
git branch --list 'feature/mcp-client-use' 'feature/mcp-loading-local'

# Sanity: tests pass on the baseline before any merge
cd packages/connector && npm test
```

If a stage is `done — <SHA>` in the table, jump to the next `not started` row. If a stage is `in_progress`, read its commit + test output before deciding whether to continue or restart it.

## Status

`Status: completed 2026-06-22` (pending S10 fast-forward — when this file is moved to `Done/`, S10 has run).

The two feature branches are left in place per memory `keep_feature_branches_after_merge.md`. The integration branch `mcp-shim-merge` is also left in place for the diff trail; not pushed to origin per `feature_branches_local_only.md`.




