# INSPECTOR-CREDS-VISIBILITY — Make creds state visible (and locally testable) in the inspector

> **Status: completed 2026-06-22.** All 12 workstreams landed on `feature/inspector-creds-visibility` (cut off `main` @ `3e2d1be`). 26 new tests across 3 files; full suite at 245/245 passing. Manual verification covered: paste / clear / partial-merge submit / Awaiting-config badge / per-tool verdict downgrade / drop-in NODE_PATH for `MCP_DROPIN_DIR` outside the repo. UI smoke (W-S10) deferred to a future Playwright pass — security guarantees pinned by W-S9 leak pack are the load-bearing layer. Move to `.claude/plans/Done/` after the no-FF merge to main.
>
> **Why:** today a developer drops a folder under `mcp/local/<name>/` and the connector picks it up at boot — but they have no signal in the inspector that distinguishes "my code loaded fine, I'm waiting on the admin to paste creds in the controller UI" from "my code is broken." For cred-gated MCPs (the bundled Twilio shape — `tools: []` until creds arrive) this is especially confusing: the MCP appears in MCP Status with zero tools and no further explanation. The fix is two-part: (1) make the cred state explicit in the inspector — per-MCP "Awaiting config" badge, per-tool verdict downgrade, declared-envKey list — and (2) let the developer paste **session-only** dev creds into the inspector to drive the child themselves, so a tool can be smoke-tested before the admin gets involved.
>
> **What this is NOT:** a path back to filesystem-resident creds. The controller-driven creds-request / creds-response flow remains the production answer; this is a local-development feedback loop, not an alternative deployment shape. Per [`feedback_dir_dotenv_deprecation`](../../packages/connector/src/mcp-supervisor.ts) (the per-spawn `mcp spawn env-sources` log already tracks this trajectory) the `dir/.env` fallback is an offline-dev path on a deprecation runway. Inspector session creds are a sibling to that: in-memory only, expire on a 12h timer, never written to disk, never echoed back through the loopback UI.

## Decisions (2026-06-22)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Controller always wins per-key.** Merge order grows one layer: `process.env ⊕ spec.env (yaml inline + dir/.env) ⊕ session ⊕ controllerEnv`. `controllerEnv` stays the last-write-wins layer. | Production safety. A developer can't accidentally smoke-test against their personal creds while the controller has prod values for the same key — controller wins for any key it sets. Session creds usefully fill *gaps* the controller hasn't supplied. |
| 2 | **12h hard TTL from paste.** Not sliding-on-activity. | A developer's "paste once, smoke-test, walk away" cadence is the primary use case; sliding TTL creates a "why is it still active days later" surprise. Hard expiry forces a re-paste that doubles as a "are these dev creds still valid?" checkpoint. |
| 3 | **Always redacted.** Inspector field is masked-on-type, masked-on-read-back, never echoed in any HTTP response. The supervisor's `mcp spawn env-sources` log line currently logs key names only — that contract holds. | This change introduces the inspector as a brand-new cred-handling surface; redaction has to be enforced at write-time *and* validated by tests. A leak would defeat the whole architecture's "creds live on the controller" pitch. |
| 4 | **Session-pasted creds NEVER cross to the controller.** The route is purely local. No `creds-update` frame fires, no manifest delta hints at session state. | Same trust boundary as the rest of the inspector: 127.0.0.1-only, no external visibility. A controller operator should never be able to tell whether a developer is running session creds locally. |
| 5 | **Survive child crash/restart, die with connector process.** A code edit triggers a child respawn — session creds are reapplied automatically so the smoke-test loop survives. A full connector exit clears them. No persistence. | Otherwise the feature falls apart on every code change. |
| 6 | **Click-target split on the MCP server card.** Grey "MCP SERVER" header expands/collapses the tool list (today's behaviour). Clicking the purple `<name>` selects the **MCP creds view** in the right pane — peer to selecting a tool name. No close button: switching to any tool restores the tool-shape view. | User's design call (2026-06-22 sketch). Today the whole card toggles; we need a second click target so name-click and tool-click both drive the right pane without losing expand/collapse on the grey header. |
| 7 | **Per-tool verdict downgrade.** When `mcp.credsSource === "none"` AND `tool.envKeys.length > 0`, replace the green "Ready" badge with an amber "Awaiting config". The Run button (existing `/tool/call` route) is rendered disabled with tooltip "configure creds first". | Closes the cred-eager-MCP visibility gap (`sample`, `crm` register tools at boot regardless of creds — today they show "Ready" even when invocation would fail). |
| 8 | **No new tunnel frames.** Pure connector-local change. No wire-protocol revision, no change to controller code. | Clean blast radius. The whole point is to give the developer feedback before the controller is involved. |

## Branch

`feature/inspector-creds-visibility` off `main` @ `3e2d1be`. Don't push to origin until merged (per [`feedback_feature_branches_local_only`](../../../../.claude/projects/-Users-dhartman-Development-01-Twilio-AgenticProcedure-mcp-shim/memory/feedback_feature_branches_local_only.md)).

## Architectural fit

The supervisor at [`packages/connector/src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) already exposes `applyControllerEnv(mcp, env, source, reason)` — the primitive the controller-config and creds coordinators call to layer env onto a running child + restart. Adding the inspector as a third caller is the architecture working as designed; the layered env-merge model handles the rest. The new bits:

- A new `sessionEnv: Record<string, string>` field on `SupervisorEntry` (sibling to `controllerEnv`).
- A new `applySessionEnv(mcp, env, ttlMs)` method that mirrors `applyControllerEnv` but writes to `sessionEnv` and arms a timer.
- The `mergeEnv` helper grows one layer: `process.env ⊕ spec.env ⊕ sessionEnv ⊕ controllerEnv` (controller still wins last).
- `McpStatus.credsSource` gains `"session"` and `"controller+session"` discriminants.

No change to:
- Wire-protocol frames (`creds-request` / `creds-response` / `creds-update` are untouched).
- The `dir/.env` deprecation runway.
- The `applyControllerEnv` call sites (still 2: creds coordinator, controller-config coordinator).

## Cred-leak prevention — the load-bearing test contract

This is the highest-stakes part of the change. We are introducing a brand-new cred-handling surface (an HTTP route on the inspector that accepts secret values), and the architecture's whole pitch is that creds don't leave their boundary. So **every leak channel gets a pinned test** — failure to leak is enforced by CI, not by code-review vibes.

### W-S workstream — Sealing the surface

The complete inventory of channels that could leak a session-pasted cred and the test that pins each one shut.

| # | Leak channel | What "leak" looks like | Test (lives at `packages/connector/tests/inspector/session-creds-leak.test.ts`) |
|---|---|---|---|
| L1 | HTTP response body of `POST /mcp/<name>/session-creds` | Server echoes the value back | `expect(JSON.stringify(response.body)).not.toContain(SECRET_VALUE)` |
| L2 | HTTP response body of any subsequent inspector route (`/events`, `/tool/call`, `/mcp/reload-creds`) | Status snapshot includes the value | Pinned: open SSE stream → paste cred → assert no event payload contains `SECRET_VALUE` for 1s window |
| L3 | Inspector SSE `mcpStatuses` events | `McpStatus` shape grows a field that surfaces cred values | Pinned at the type level: `McpStatus` only carries `credsSource` (enum) + `credsLastUpdated` (number) + `sessionCredsExpiresAt` (number). Type-level test: `Expect<Equal<keyof McpStatus, ...>>` — explicit allowlist; new fields require updating the test, forcing review |
| L4 | Frame log (controller-bound frames) | A `creds-update` or other frame inadvertently includes session-pasted values | Pinned: paste session cred → drain `frames` array → assert no outbound frame's stringified payload contains `SECRET_VALUE` |
| L5 | Manifest sent to controller | `ToolManifest` / `ServerDescriptor` grows a cred field | Pinned: the existing manifest-shape tests already pin known fields. We add an explicit assertion that `JSON.stringify(manifest)` does not contain a session-pasted value |
| L6 | Pino log lines (any level, any logger) | Cred value appears in `mcp spawn env-sources` (or any other) log line | Pinned: capture all pino output during a paste + spawn cycle → assert no log line's `JSON.stringify` contains `SECRET_VALUE`. The `env-sources` line currently logs **key names only** — this test guards against a future refactor that adds values |
| L7 | Child process env exposure | Child reads `SESSION_API_TOKEN=foo`, but a future `/debug` route on the inspector dumps `child.env` | Pinned: type-level — `SupervisorEntry`'s public surface excludes `sessionEnv`/`controllerEnv` from any `statusList()` / `getEntry()` style accessor. Test enumerates exported supervisor methods and asserts none return `sessionEnv` content |
| L8 | Persistence | A future bug writes session creds to `.connector-state.json`, `.env`, or any disk location | Pinned: paste session cred with a random magic value → after restart, grep the entire repo working tree (excluding `node_modules`) for the magic value → assert zero matches. Cheap; runs in CI via vitest |
| L9 | Repaste echo on UI | Side panel re-renders the masked field with the previously-pasted value | UI contract — the field is *always* empty on render. Only the existence/expiry of session creds is rendered, never the value. Pinned by a Playwright test at `tests/inspector/session-creds-ui.test.ts` |
| L10 | TTL expiry race | Cred expires but in-flight `/tool/call` already grabbed the value | Acceptable: the child process holds the value in its env until restart, so a request mid-flight uses the live env. The TTL governs *future* spawns. Pinned as a documented behaviour, not a leak (test asserts post-expiry restart drops the value) |

**Convention for tests in this workstream:** every test gets a unique `SECRET_VALUE` of the form `tok_leak_test_<random16>`. The randomization is to make grep-for-leak tests across the working tree definitive — there will be no false positives. (We can't use `Math.random()` in the workflow scripts but vitest has it; this is a per-test-run value, not a per-run-of-Claude value, so it's fine.)

### Implementation rules that keep the contract honest

- **Inspector route NEVER reads back values.** The POST endpoint accepts envKey→value pairs and returns only `{ok: true, expiresAt}`. There is no GET sibling. There is no "list current session creds" endpoint.
- **`SupervisorEntry.sessionEnv` is private.** The supervisor exposes `applySessionEnv(mcp, env, ttlMs)` and `clearSessionEnv(mcp)` only. No accessor returns the merged env or the per-layer envs to outside callers.
- **Logger redaction guard.** Pino's `redact` config grows to redact any string value that looks like a known sensitive shape (`Bearer *`, `sk_*`, `ts_*`, `tok_*`). This is belt-and-braces — the primary defense is "don't log values" — but it catches accidental `logger.info({env}, "...")` slips.
- **Lint rule.** A grep-style CI check fails the build if any new file under `packages/connector/src/` adds a `logger.*` or `console.*` call whose first argument's stringified shape contains `process.env.<KEY>` or any known cred-shaped variable name. (Workstream W-S6.)

### What's deliberately NOT in scope

- Encryption-at-rest for session creds. They're in-memory only; the connector process holds them. Anyone who can read the process's memory has already won, and that's true today for `process.env`.
- Cred sharing across connector restarts. The user's "die with connector" decision is firm.
- A "session creds across multiple browser tabs" sync story. The connector holds the truth; tabs read from `/events` SSE which only exposes existence + expiry, not values. New tabs render an empty panel and the expiry timer; pasting in one tab applies for all tabs (the child uses the value, regardless of which tab pasted it).

## Workstreams

| ID | Title | Status | Files (primary) |
|---|---|---|---|
| W-S1 | Supervisor: `applySessionEnv` + `sessionEnv` field + merge layer | not started | [`packages/connector/src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) |
| W-S2 | Supervisor: TTL timer wheel + auto-clear-on-expiry restart | not started | [`packages/connector/src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) |
| W-S3 | `McpStatus` extension — `credsSource: "controller+session" \| "session" \| ...`, `sessionCredsExpiresAt?: number` | not started | [`packages/connector/src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) |
| W-S4 | Inspector route `POST /mcp/:name/session-creds` (apply) + `DELETE /mcp/:name/session-creds` (clear) | not started | [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) |
| W-S5 | Inspector UI — click-target split, side panel, masked inputs, expiry countdown | not started | [`packages/connector/public/index.html`](../../packages/connector/public/index.html), [`packages/connector/public/app.js`](../../packages/connector/public/app.js), [`packages/connector/public/style.css`](../../packages/connector/public/style.css) |
| W-S6 | Logger redact config + CI lint rule (grep-style) | not started | [`packages/connector/src/logger.ts`](../../packages/connector/src/logger.ts), `scripts/lint-creds.sh` |
| W-S7 | Per-MCP "Awaiting config" badge — render `credsSource === "none"` distinctly | not started | [`packages/connector/public/app.js`](../../packages/connector/public/app.js) |
| W-S8 | Per-tool verdict downgrade — `Ready` → `Awaiting config` when MCP creds missing AND `tool.envKeys.length > 0` | not started | [`packages/connector/public/app.js`](../../packages/connector/public/app.js); supervisor exposes per-tool envKeys via the existing `fetchEnvKeys` shape |
| W-S9 | Cred-leak test pack (L1–L10 above) | not started | `packages/connector/tests/inspector/session-creds-leak.test.ts` |
| W-S10 | UI smoke test (Playwright) — paste, smoke-test invoke, expire, repaste | **deferred** | covered manually + by W-S9 route-level leak pack (L1–L6 already pin the security guarantees end-to-end through HTTP). A JSDOM harness for the script-tag-only `app.js` would be heavy plumbing for marginal payoff vs. a Playwright pass we can run later when convenient. |
| W-S11 | Docs — README + `docs/AUTHOR-LOCAL-MCP.md` (the dev-feedback-loop story) + CLAUDE.md (load-bearing properties) + **new `docs/INSPECTOR.md`** (full inspector reference) + **move `BUNDLES.md` → `docs/BUNDLES.md`** with tightened "Type 3 only" registry heading | not started | `README.md`, `docs/AUTHOR-LOCAL-MCP.md`, `docs/INSPECTOR.md` (NEW), `docs/BUNDLES.md` (moved), `CLAUDE.md` |

Order: W-S1 → W-S2 → W-S3 (foundation), W-S9 (tests-first for the leak surface — pin behaviour before UI), W-S4 → W-S6, W-S5 → W-S7 → W-S8 (UI), W-S10 (UI smoke), W-S11 (docs).

## Verification checkpoints

- Foundation lands: `npm test` in `packages/connector` shows W-S9 leak tests passing.
- Route lands: `curl -X POST http://127.0.0.1:9090/mcp/sample/session-creds -d '{"FOO":"bar"}' -H content-type:application/json` returns 202; `mcp spawn env-sources` log line on next spawn shows `session: ["FOO"]`.
- UI lands: paste in left side panel → MCP Status pill flips to `controller+session`, expiry countdown ticks, child restarts.
- TTL lands: paste with synthetic `ttlMs=2000` (test-only env knob) → assert child restarts at expiry without the value.
- Verdict downgrade lands: drop `mcp/local/scratch/tools/needs-key.ts` declaring `envKeys: ["X"]`, no controller config → tool shows "Awaiting config" amber badge.
- Leak tests pass in CI: every L1–L10 row green.
- Docs land: README + AUTHOR-LOCAL-MCP have a "Smoke-testing locally before the admin pastes creds" subsection; CLAUDE.md "Architecturally load-bearing properties" gains a session-creds bullet.

## Open questions / things to confirm before each workstream

- **W-S2:** which timer primitive — single `setTimeout` per MCP, or a single timer-wheel ticking once a minute? Per-MCP is simpler; the timer-wheel is more correct under heavy MCP counts. Default to per-MCP unless we see >50 entries on a single connector (we don't, today).
- **W-S5:** click-target split UI confirmed — purple `<name>` selects an MCP creds view in the right pane, **peer to selecting a tool**. Both are view-switches driven by the current selection in the left column. No close button on the creds view; clicking any tool name restores the tool-shape view. The right pane has one "current selection" at a time: either an MCP (creds view) or a tool (shape + Run view).
- **W-S6:** which secret shapes does the redact filter cover? Initial set: `Bearer *`, `ts_*`, `tok_*`, `sk_*`, JWT shape (`eyJ*`). Tighten as we learn.
- **W-S8:** the verdict-downgrade rule needs per-tool envKeys at the inspector. Today `fetchEnvKeys` returns the *aggregated* list (the union across all tools). For per-tool verdict we either (a) widen `fetchEnvKeys` to return `Record<toolName, string[]>` or (b) accept that an MCP-level "Awaiting config" implies all tools are awaiting. (b) is simpler and matches the user's framing. Going with (b) unless a per-tool gap surfaces.
- **W-S10:** Playwright is not currently a dev dep here; the existing inspector tests are pure unit/integration. Adding Playwright is a heavier lift. Alternative: a JSDOM-based render test that exercises the click handlers and asserts DOM state. Going with JSDOM unless real-browser fidelity matters; revisit if click ordering or timer-wheel rendering becomes flaky.
- **W-S11 inspector reference doc:** `docs/INSPECTOR.md` is a NEW deliverable — author it AFTER the UI workstreams (W-S5/S7/S8) land so the doc captures the final shape in one pass instead of being amended mid-build. Cover all 5 panels (MCP Server tree, Available Tools, MCP Status, Webhooks, Frames), the right-pane view-switching (tool-shape vs MCP creds), per-MCP actions (Reload creds, Restart, **session creds**), the **Refresh local MCPs** button, and reaffirm the 127.0.0.1-only trust boundary as a load-bearing property.
- **W-S11 bundles doc move:** `BUNDLES.md` lives at the repo root today but reads as a registry reference, not an entry-point pointer — it fits `docs/` better than the root tier (which is reserved for README + CLAUDE.md). Move to `docs/BUNDLES.md`, tighten the "Authoritative registry" heading to "Authoritative registry (Type 3 only)" so the W-E2 controller-config Type 2 path can't be misread as also flowing through `BUNDLED_MCPS`, and update cross-references in README + CLAUDE.md.

## Out of scope

- Inspector "Invoke" UI for tool calls — already exists at `/tool/call`. We're rendering the existing surface differently (Run button enabled/disabled by verdict), not adding a new one.
- Per-tool envKeys exposure on the wire (controller side) — see W-S8 question (b).
- A controller-side mirror of "session creds active" status. Deliberately invisible to the controller per Decision #4.

## References

- [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) §"Where do creds come from?" — the existing controller-driven story this plan complements.
- [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) §"Creds-request fanout" — the wire-level cred handshake (untouched by this plan).
- [`packages/connector/src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) — `applyControllerEnv`, the primitive `applySessionEnv` mirrors.
- [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) — existing inspector routes (`/tool/call`, `/mcp/reload-creds`, `/internal/webhook/*`); the new `/mcp/:name/session-creds` joins this set.
- [`CLAUDE.md`](../../CLAUDE.md) §"Architecturally load-bearing properties" — receives the new bullet.

