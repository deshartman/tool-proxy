# ENV-TO-DB — tunnel creds move from `.env` into a Postgres row, editable via the inspector

> **Status:** completed **2026-07-13** on branch `feature/env-to-db` (merged to `main`).
>
> **Post-merge Step-8 retrospective fix (2026-07-20, branch `feature/agentic-memory-mock`):** Step 8's "WARN under db mode" landed with an ordering miss — `interpolateEnv()` runs on the raw yaml BEFORE `bootFromDb` can log the WARN, so a legacy `tunnel:` block with `${CONTROLLER_URL}` (bare, no default) hard-throws at load time when a db-mode operator has stripped legacy env vars per the migration doc. The plan text at line 381 stated the block should be "optional-with-WARN under db mode"; the implementation only added the WARN. Full retrospective + fix inventory in [Step 8's section below](#step-8--keep-the-tunnel-yaml-block-offline-ok--complete-2026-07-11--retrospective-fix-2026-07-20). Two-line summary: (a) made `tunnel:` optional in the zod schema and relaxed `controller_url`/`name` to accept empty strings, (b) changed shipped yaml.example's tunnel-block interpolators from `${VAR}` to `${VAR:-}` (plus fixed bare-`${VAR}`-in-doc-comments that were also throwing). Regression test #4 in [`interpolate-env.test.ts`](../../packages/connector/tests/config/interpolate-env.test.ts) loads the SHIPPED `.example` file with truly-unset env vars — this test would have caught the original bug directly. 404 tests pass (up from 386).
>
> **Scope:** exactly one controller today. Multi-controller (N tunnels per connector process) is the target shape in [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md); this plan is deliberately a **strict subset** of that design so nothing here has to be rewritten when Phase-2 lands.
>
> **Companion docs.**
> - [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md) — the N-controller target this plan makes the first step towards.
> - [`CREDS-ENCRYPTION.md`](CREDS-ENCRYPTION.md) — sealed-box wire encryption. Orthogonal to this plan (which is storage-at-rest), but the master-key sourcing shape is aligned.
> - [`DEPLOY-ARCHITECTURE.md`](DEPLOY-ARCHITECTURE.md) — per-cloud runtime shapes. Postgres already runs alongside the connector for the `enterprise-knowledge` bundle.

## 🚦 RESUME POINT — read this first

**Read this section before any other section of the plan. It reflects the actual state on disk as of 2026-07-11.**

### What's done (do NOT redo)

| Step | Status | Files | Commit |
|---|---|---|---|
| 1 — Prerequisites (branch, npm install, master.key, gitignore) | ✅ done | `.local/master.key`, lockfile bump | `cae3ebb`, `3e7b755` |
| 2 — Create `config-store/` module + `boot/creds-source.ts` | ✅ done | see file inventory below | `22f57c3` |
| 3 — Unit tests for the config-store (34 tests, all green) | ✅ done | `tests/config-store/*.test.ts` | `22f57c3` |
| 4 — Rewire `requireEnv` to branch on `credsSource` (13 new tests) | ✅ done | `require-env.ts`, `creds-source.ts` + tests | `90d474f` |
| 5 — Split `resolveAuth` into env / row exports (6 new tests) | ✅ done | `auth.ts` + tests, `lifecycle.ts` call site | `7eef148` |
| 6 — Split `boot()` into env/db dispatchers | ✅ done | `lifecycle.ts` only (+550 lines) | `b9d683d` |
| 7 — CANCELLED per D1 | — | (state.ts stays alive) | — |
| 8 — WARN on legacy `tunnel:` yaml block under db mode | ✅ done (2026-07-11) + retrospective fix (2026-07-20 — original shipped broken; see [Step 8 section](#step-8)) | `lifecycle.ts` +5, `connector.yaml.example` +7, retrospective: `config.ts` (schema optional), `lifecycle.ts` (guard), `manifest/build.ts`, both yamls, `tests/config/interpolate-env.test.ts` (+4 tests incl. shipped-fixture) | `21efcf9`; retrospective on `feature/agentic-memory-mock` |
| 9a — Inspector tunnel routes + backend wiring (15 tunnel-route tests + 2 deleteController) | ✅ done | `inspector/tunnel-routes.ts` (new), `inspector/server.ts`, `lifecycle.ts` (dialTunnel/cycleTunnel extraction), `config-store/index.ts` (deleteController) | `94dc0e3` + `233d33f` follow-up (dial-on-upsert + rollback) |
| 9b — Inspector Tunnel panel + modal form | ✅ done | `public/{index.html,app.js,style.css}` | `bbd52c4` |
| 10 — `.env.example` both-modes + legacy-var WARN loop | ✅ done | `.env.example`, `lifecycle.ts` | `dbc5b3a` |
| 11 — leak-channel + logger redact backstops (12 new tests) | ✅ done | `logger.ts`, `logger/redact.test.ts`, `inspector/tunnel-creds-leak.test.ts` (new) | `d09baa9` |
| 12 — docs update (CLAUDE.md + README) | ✅ done | `CLAUDE.md`, `packages/connector/README.md` | `b99c969` |
| Post-12 hardening — TDZ fixes (`auth` / `tunnelDialUrl` / `registrationToken`) + regression test | ✅ done | `boot/lifecycle.ts`, new `tests/boot/lifecycle-tdz.test.ts` (19 tests) | `de52157` + `9dfcdfe` |
| Post-12 hardening — env→db migration helper for stale `.connector-state.json` | ✅ done | `scripts/migrate-registration-token.mjs`, README §"Migrating from env mode" | `ed5b155` |
| Post-12 UX — Controller URL normalization (strip `/mcp-tunnel[/…]`) | ✅ done | `inspector/tunnel-routes.ts` `normalizeControllerUrl`, tests | `3a0ae79` |
| Post-12 UX — modal collapse to two required fields + optional Display name | ✅ done | `public/{index.html,app.js,style.css}`, tunnel-routes handler | `abc1ab7`, `b137737`, `ee546d8` |
| Post-12 fix — `writeState('')` no-op guard for db-mode | ✅ done | `state.ts`, tests | `0d915a4` |
| Post-12 fix — `cycleTunnel` refreshes row from DB before reconnect | ✅ done | `boot/lifecycle.ts`, `tests/inspector/tunnel-routes-cycle-refresh.test.ts` | `a3b069a` |
| Post-12 UX — sharpened Force re-registration confirm | ✅ done | `public/app.js` | `e62ed8d` |

File inventory (Steps 2–3):
```
packages/connector/src/config-store/
  ├── schema.ts        (exports schemaSql(schema): string — see gotcha #1)
  ├── master-key.ts    (resolveMasterKey() — reads CONNECTOR_KEY_FILE, checks mode 0600, returns 32B + sha256 fp)
  ├── seal.ts          (initSodium / seal / open — libsodium crypto_secretbox_easy; see gotcha #2)
  └── index.ts         (ConfigStore class: open, getController, upsertController, updateRegistrationToken, clearRegistrationToken, recordConnect, recordDisconnect, close)
packages/connector/src/boot/
  └── creds-source.ts  (resolveCredsSource(): "env" | "db", default "db")
packages/connector/tests/config-store/
  ├── seal.test.ts             (5 tests — round-trip, tamper, wrong-key, truncated)
  ├── master-key.test.ts       (7 tests — missing / bad-mode / bad-length / round-trip / fingerprint-differs)
  ├── creds-source.test.ts     (9 tests — default / empty / valid / invalid / case-sensitivity)
  └── config-store.test.ts     (13 tests, requires POSTGRES_URL — open, upsert, get, updateRegistrationToken, clearRegistrationToken)
```

### How to run the tests (Steps 4+ MUST keep these green)

The connector's `mcp-shim-ek-postgres` container hosts EK's Postgres. Reuse it — one server, one database (`enterprise_knowledge`), isolated by schema:

```bash
POSTGRES_URL="postgres://ek:ek-dev-password@localhost:5433/enterprise_knowledge" \
  npm test --workspace @mcp-shim/connector
```

Expected: **300 tests pass across 34 test files** (the pre-existing suite + Steps 2–3's 34 new tests). EK's `public` schema — tables `data_data_src_*`, `ek_sources` — MUST remain untouched by any test.

### Post-Step-12 runtime discoveries (2026-07-11 → 2026-07-13 — real dev-loop testing)

Six issues surfaced when actually booting the connector in db mode against a live controller. All fixed on-branch before merge. The unifying theme: bindings/paths that were fine under `bootFromEnv`'s tight coupling need explicit plumbing under `bootFromDb`'s branch structure. Every one of these was found by an operator hitting a stuck state, not by a test — enough of them that the next iteration should include a live-Postgres boot integration harness.

**A. TDZ trap in `bootFromDb` — closure captures across the empty-DB return.** The dialTunnel closure was wired into the inspector routes BEFORE `store.getController()`, but three bindings the closure body (and `connectTunnelDb`, which it invokes) reads — `auth`, `tunnelDialUrl`, `registrationToken` — were declared LATER in bootFromDb, inside the row-exists branch. Under the empty-DB paste flow the closure fired while the outer `let auth = …` / `let tunnelDialUrl = …` / `const registrationToken = …` lines had never executed, throwing `Cannot access 'X' before initialization` visible in the modal's error banner.

Fixes:
- `de52157` — hoist `let auth: AuthResolution | undefined` and `let tunnelDialUrl: string | undefined` above `store.getController()`; change the row-exists path from re-declare to assign; add `!auth || !tunnelDialUrl` guard in `connectTunnelDb`.
- `9dfcdfe` — read `row.registrationToken ?? undefined` into a local `currentToken` at the top of `connectTunnelDb` instead of capturing the outer `const registrationToken`.

Regression coverage: `packages/connector/tests/boot/lifecycle-tdz.test.ts` (19 tests, `9dfcdfe`). Source-level static analysis — splits `bootFromDb` at the empty-DB return marker, iterates a list of identifiers the empty-DB paste flow captures, asserts each captured binding is declared ABOVE the return (or not declared at all — i.e. an import/broader scope). Nested-function bodies (e.g. `const creds` inside `connectTunnelDb`) are correctly excluded. This is the cheap-and-reliable check that catches any future refactor that reintroduces the pattern; a full integration test would be authoritative but bootFromDb has enough machinery (`McpSupervisor`, `TunnelClient`, drop-in discovery, yaml `mcp_servers.min(1)` validation) that a proper harness is a separate project.

**Discipline for future contributors:** in bootFromDb, ANY outer-scope binding that could be read from a callback wired via `inspector.wireTunnelRoutes(...)` — meaning the empty-DB paste flow can invoke it — MUST be declared above the empty-DB return. If a value is only meaningful when a row already exists, either compute it fresh inside `connectTunnelDb` from `row.*` (which is already hoisted), or hoist the binding with an `| undefined` union type and guard on read.

**B. Migration gap — legacy `.connector-state.json` isn't auto-imported.** An operator upgrading from env mode has a stale `.connector-state.json` on disk carrying the `registrationToken` the controller minted for their prior `mcp-tunnel` connectors row. Under db mode, `bootFromDb` doesn't read that file (D11 says delete after first register-ack, not import). First register-ack under db mode arrives at the controller carrying no token, controller sees "you already have an mcp-tunnel row" and rejects with `code: "organisation_has_connector"`. The connector correctly sets `registrationRejected` and suppresses auto-reconnect; the operator gets stuck.

The rejection is the correct behavior — the controller MUST refuse to bind an existing connector row to a caller that can't prove ownership. What's missing is a migration hook that seeds the token from disk into the DB row on first db-mode boot, before the register frame goes out.

Ships in this branch as an OPT-IN one-shot script: `scripts/migrate-registration-token.mjs`. Usage documented in `packages/connector/README.md` §"Migrating from env mode". The script:
1. Reads `.connector-state.json` from CWD.
2. Opens the ConfigStore with the same `POSTGRES_URL` + `CONNECTOR_KEY_FILE` the connector uses.
3. Refuses to overwrite an existing sealed token.
4. Otherwise seals + writes the token into `controllers.registration_token_ct`.
5. Prompts the operator to click Reconnect. On successful register-ack, D11 deletes the state file.

**Follow-up for Step 14 (feature-flag removal):** promote this from a script to unconditional logic in `bootFromDb` — if `getController()` returns a row with `registration_token_ct = NULL` AND `.connector-state.json` exists with a `registrationToken`, seed it and try to dial. That's the last remaining rough edge in the env→db migration story. Doing it during Step 14 (rather than now) is intentional — the script gives us a safe opt-in for the transition release; automatic seeding belongs to the release that also removes env mode entirely.

**C. Static-analysis regression testing beats brittle integration harnesses (for this class of bug).** The lifecycle-tdz.test.ts approach — read source, split at a marker, regex captured identifiers vs declaration positions — is cheaper, faster (~4ms per run), and more targeted than trying to spin up a live bootFromDb with a real Postgres + a mocked controller. It won't catch every future refactor's edge cases, but for the "closure captures binding declared below an early-return" pattern specifically, it's authoritative. Worth reaching for when the runtime harness is disproportionate to the bug class.

**D. Controller URL copy-paste footgun — full WS endpoint pastes bad.** The controller UI's "Copy Controller URL" button emits the full WS path (`https://tap-des.ngrok.dev/mcp-tunnel/tunnel`), but the connector's tunnel/client.ts appends `/mcp-tunnel` itself. Pasting the full URL doubled-appended the path and 404'd on dial. Fix `3a0ae79`: `normalizeControllerUrl()` in `inspector/tunnel-routes.ts` strips `/mcp-tunnel[/…]` before persisting. Idempotent, case-insensitive, preserves unrelated paths so they still fail loudly. 11 tests cover the normalizer + one integration test on the POST /creds flow.

**E. `writeState('')` ENOENT on every successful register-ack.** Under db mode, `bootFromDb` passes `statePath: ""` to createFrameRouter because the registrationToken lives in Postgres. But frame-router.ts's default register-ack handler still called `writeState(state, statePath)` unconditionally. Empty statePath → `renameSync('.tmp', '')` → ENOENT. The error was caught by frame-router's try/catch, so register-ack succeeded on the wire, but the ERROR log line was scary and made operators think the token hadn't persisted (it had, via the db-mode custom onframe hook that ran separately). Fix `0d915a4`: `writeState` and `clearRegistrationToken` now no-op when path is falsy. 3 new tests pin the empty-path guard.

**F. `cycleTunnel` didn't refresh row from DB before reconnect.** Discovered while testing credential rotation end-to-end. Operator rotates the Tunnel Security row on the controller, pastes the new bearer via the Edit modal, hits Save & reconnect. The DB row's `tunnel_auth_token_ct` correctly rewrites with the new sealed value, cycleTunnel("credential-rotated") fires — but the connector's next WS upgrade PRESENTED THE STALE bearer from the initial boot, causing controller 401. Root cause: bootFromDb's cycleTunnel closure called `reconnect(reason, { manual: true })` without refreshing the in-memory `row` / `auth` / `tunnelDialUrl` bindings. The parallel dialTunnel closure (INSERT case) DID refresh — that's why the initial paste worked but every subsequent rotation was broken. Fix `a3b069a`: cycleTunnel now calls `store.getController()` and re-populates row/auth/tunnelDialUrl before reconnect. Pinned by `tests/inspector/tunnel-routes-cycle-refresh.test.ts` at the routes level; the bootFromDb-side refresh confirmed against live logs.

**G. `${CONTROLLER_URL}` in yaml throws before Step 8's WARN can fire (retrospective, 2026-07-20 on `feature/agentic-memory-mock`).** Bug class matches the theme above: a code path (`interpolateEnv` → `loadConfig` → zod validate → `bootFromDb.log.warn`) that was FINE under env mode — because `requireEnv` gated the vars as set before yaml load — breaks under db mode where the operator has stripped those vars per the migration doc. Interpolation is a pre-parse text pass with no yaml awareness, so a bare `${CONTROLLER_URL}` in the tunnel block (or in a doc comment mentioning it) throws before `bootFromDb` sees any `config` object. The "eyeball-verifiable at boot" acceptance in Step 8's original body was done on a dev machine with populated env vars; the target end state (stripped `.env`) never got exercised.

Fixes (in two layers — the shape fix and the systemic backstop):

**Layer 1 — shape fix (schema + yaml):**
- `packages/connector/src/config.ts` — `tunnel:` block made OPTIONAL at the top level (this finishes what the plan's line 381 called for; original Step 8 landed only the downstream WARN). `controller_url` widened to `z.string().url().or(z.literal(""))`. Both `controller_url` and `name` gained a `preprocess(null → "")` (YAML parses bare `key: ` as null, not empty string, so preprocess normalizes).
- `packages/connector/src/boot/lifecycle.ts` — `bootFromEnv` gained a defensive guard that throws with an operator-actionable message when `config.tunnel` is missing or its required fields are empty. A local `tunnelConfig` const is hoisted right after the guard so async closures (`connectTunnel`, register-frame send, mcp-config-coordinator) get TS narrowing.
- `packages/connector/src/manifest/build.ts` — one `config.tunnel?.environment ?? "dev"` for the newly-optional block.
- `connector.yaml.example` and dev `./connector.yaml` — tunnel keys changed to `${VAR:-}` shape. Dev's `./connector.yaml` had its `tunnel:` block removed entirely (target end state under db mode).
- `docs/deploy/gcp-gke.md` + `docs/deploy/aws-fargate.md` — customer-facing yaml samples updated to `${VAR:-}` shape with an explicit env-vs-db-mode note. Prevents future customers copy-pasting from the deploy guide and hitting the same failure.

**Layer 2 — systemic backstop (`interpolateEnv` comment-skip):**
The shape fix (above) is necessary but not sufficient — it addresses the tunnel BLOCK values, but the original bug ALSO manifested via `${CONTROLLER_URL}` in DOC COMMENTS. `interpolateEnv` was a pre-parse text pass that matched inside yaml comments (comments are only stripped by the yaml parser, which runs AFTER interpolation). So a documentation comment like `# Vars like ${CONTROLLER_URL} are interpolated from .env` would trip the interpolator when CONTROLLER_URL was unset.

- `packages/connector/src/config.ts` `interpolateEnv` — refactored to split-lines-and-skip: full-line yaml comments (lines whose first non-whitespace character is `#`) are now inert. Inline comments (`key: value # inline`) are still strict — the case is rare enough not to warrant a yaml-quote-aware inline scanner, and the failure mode is easy to fix if hit. This aligns the interpolator with yaml's own semantics (comments never affect parsed state) and makes it structurally impossible to hit this class of bug via a doc comment.

Test coverage for the systemic fix in `packages/connector/tests/config/interpolate-env.test.ts`:
- **"full-line yaml comments are inert"** — pins the new contract. A yaml with `# ${UNSET_VAR}` in a comment loads cleanly even when UNSET_VAR is genuinely undefined.
- **"inline comments after values ARE still interpolated"** — pins the deliberate non-goal so a future refactor understands the scope.
- **"SHIPPED connector.yaml.example loads cleanly with no tunnel env vars set"** — the belt-and-braces test: loads the real .example file with `vi.stubEnv(x, undefined)` on every tunnel env var. Would have caught the original Step 8 bug directly. Failure of THIS test is the load-bearing signal for the whole regression.

Verified end-to-end: `./scripts/start-connector.sh` under db mode with `.env` containing only `POSTGRES_URL` + `CONNECTOR_KEY_FILE` (no legacy per-controller vars) boots cleanly, tunnel dials via DB row, register-ack succeeds. 406 tests pass (up from 386).

Also updated: CLAUDE.md's YAML-interpolation paragraph now documents the comment-inertness rule as a load-bearing property. CLAUDE.md's identity + auth paragraphs updated to accurately reflect the db/env-mode split (previously claimed `${CONNECTOR_NAME}` interpolation throws at yaml load — no longer true).

**Lesson for Step 14:** when a migration says "you don't need X anymore," the test that ships alongside MUST exercise the "X is truly absent" scenario, not "X is empty-but-present." `vi.stubEnv(key, "")` and `vi.stubEnv(key, undefined)` are DIFFERENT — the former sets the var to empty string (interpolator returns "" verbatim), the latter deletes it from `process.env` (interpolator throws unless there's a `${VAR:-}` default). The distinction cost one test-iteration to notice during this retrospective. Pin it in your head before Step 14 lands.

**Also for Step 14:** the `${VAR}` → `${VAR:-}` shape in the yaml.example is a *caretaker workaround*. When Step 14 removes env mode entirely, the correct end state is to also remove the `tunnel:` block from `connector.yaml.example`. Keep the fixture regression test (loads the .example with unset env) — that test's assertion will just shift from "tunnel block parses to empty fields" to "config.tunnel is undefined".

### Modal collapse (Path-A UX preview)

Alongside the fixes above, the Configure Tunnel modal collapsed from five operator-typed fields to two required + one optional, informed by the design doc at [`CONNECTOR-ID-AS-IDENTITY.md`](CONNECTOR-ID-AS-IDENTITY.md):

- **Required:** Controller URL, Tunnel auth token
- **Optional:** Display name (defaults to URL hostname if blank; purely cosmetic on the connector side)
- OAuth2 posture is available via a `▸ Use OAuth2 client_credentials instead` disclosure link
- Server-side, `handlePostCreds` auto-fills `connector_name` from the URL hostname and drops `environment` entirely; the DB row's `connector_name` and `environment` columns become server-side-only concerns

Commits: `abc1ab7` (modal collapse), `b137737` (optional Display name), `ee546d8` (field reorder). No wire-protocol change — the identity model still uses `X-Connector-Name` on the WS upgrade. Full ID-based identity (per CONNECTOR-ID-AS-IDENTITY.md Path A) is coordinated with the controller-side cascade-from-Security-row work landing 2026-07-13; connector-side follow-up ships in a fresh branch after this one merges.

### Gotchas discovered during Steps 2–3 (steps 4+ MUST honor these)

1. **`schemaSql` is a function, not a constant.** The plan's original SCHEMA_SQL string hardcoded `mcp_connector` as the schema. Because `POSTGRES_SCHEMA` is configurable (decision D15), the DDL was refactored to `export function schemaSql(schema: string): string`. It validates the identifier against `/^[A-Za-z_][A-Za-z0-9_]*$/` and interpolates. **When Step 6 wires the boot flow, call `schemaSql(resolvedSchema)`, not a static string.** See `packages/connector/src/config-store/schema.ts`.

2. **libsodium-wrappers@0.7.15 has a broken ESM entry.** Its `dist/modules-esm/libsodium-wrappers.mjs` does `import "./libsodium.mjs"` — but that file lives in the SIBLING `libsodium` package, not in `libsodium-wrappers`. Node's ESM loader can't resolve it and fails with `ERR_MODULE_NOT_FOUND`. **The fix already in seal.ts:** load via `createRequire(import.meta.url)` — the CJS loader walks `node_modules` correctly. This is the sanctioned CJS-under-ESM pattern (see CLAUDE.md §Workspaces, `TSX_BIN` in `mcp-supervisor.ts`). **Do NOT try `import sodium from "libsodium-wrappers"` again — it will fail.** If a future dep-bump upgrades to 0.7.16+ and the ESM entry is fixed, the createRequire shim can be removed, but only after re-running the test suite to confirm.

3. **libsodium throws directly on tag-verify failure.** `sodium.crypto_secretbox_open_easy` throws `"wrong secret key for the given ciphertext"` when authentication fails — it never returns null. The `if (!pt) throw ...` fallback in `seal.ts` is dead code (kept for defensive shape). Tests match the actual libsodium message (`/wrong secret key/`), not a hypothetical one.

4. **Test isolation model.** Every `config-store.test.ts` run creates `test_mcp_connector_<Date.now()>` inside `enterprise_knowledge`, exercises it, and drops it. The `beforeAll` REQUIRES `POSTGRES_URL` to be set — it throws if not. Do NOT hardcode the URL into test source.

5. **The pre-Step-6 state leaves an empty `mcp_connector` schema in EK's Postgres** from earlier test-run experiments. Harmless — no runtime code reads it yet. Step 6's `bootFromDb` will populate it on first real dial. If it bothers you, `docker exec mcp-shim-ek-postgres psql -U ek -d enterprise_knowledge -c "DROP SCHEMA IF EXISTS mcp_connector CASCADE"` (but do NOT touch any `data_*` or `ek_*` tables — those are EK's).

### Where to pick up

**Next step: Step 13 — Final commit + merge to `main`.** All code, tests, and docs are in place. The runtime path was proven end-to-end against the reference controller after the controller-side org-uniqueness fix landed on 2026-07-13. Step 13 is a git-only operation (no-ff merge, mark the plan complete, keep the feature branch). Step 14 (feature-flag removal) is a follow-up PR one release later, on a fresh branch. **The identity-simplification follow-up plan lives at [`CONNECTOR-ID-AS-IDENTITY.md`](CONNECTOR-ID-AS-IDENTITY.md)** — coordinated with the controller-side cascade-from-Security-row work.

**Cumulative state (2026-07-13):** 386 tests pass across 39 files. Commits on `feature/env-to-db` (in order):
- `22f57c3` Steps 2-3 ConfigStore, `90d474f` Step 4 requireEnv, `7eef148` Step 5 auth split, `b9d683d` Step 6 boot dispatcher, `21efcf9` Step 8 yaml WARN, `94dc0e3` + `233d33f` Step 9a routes + dial-fix, `bbd52c4` Step 9b UI, `dbc5b3a` Step 10 .env.example, `d09baa9` Step 11 leak backstops, `b99c969` Step 12 docs
- Post-Step-12 hardening: `de52157` + `9dfcdfe` TDZ, `ed5b155` migration script + docs, `bc0e59f` `.env.example` legacy cleanup, `820ed54` docs (MCP Tunnel vs Tunnel Security naming), `3a0ae79` URL normalize, `abc1ab7` modal collapse, `e62ed8d` Force re-registration warning, `b137737` optional Display name, `ee546d8` field reorder, `0d915a4` writeState empty-path guard, `a3b069a` cycleTunnel row refresh

**Step 9 outcome summary (2026-07-11):**
- 9a landed the backend routes (`GET /internal/tunnel/config`, `POST /internal/tunnel/creds`, `POST /internal/tunnel/force-reregister`) at `packages/connector/src/inspector/tunnel-routes.ts`, wired via `Inspector.wireTunnelRoutes(...)` from `bootFromDb` only. `env` mode returns 404 on all three routes by design. Initial commit missed the dial-after-upsert flow — surfaced by manual review and fixed in follow-up `233d33f` (INSERT rollback via `deleteController()` on dial failure; UPDATE keeps row on failure).
- 9b landed the UI — a "Tunnel" panel at the top of the left column with three sub-views (env-mode banner / empty CTA / configured readout), plus a modal form with radio-toggled auth mode and password inputs that never render existing secret values. Verified in Playwright across four scenarios: empty, static-configured, oauth-configured, env-mode 404, dial-fail rollback.
- **Decision D4 was honored:** no `POST /internal/tunnel/remove` route ships in Phase-1. The plan's Step 9 body listed such a route as a fourth handler; D4 explicitly excludes it. Do NOT add it back in later steps without an explicit ask.

**Do NOT re-execute any of Steps 1–5.** If you find yourself editing `packages/connector/src/config-store/*`, `packages/connector/src/boot/creds-source.ts`, `packages/connector/src/boot/require-env.ts`, `packages/connector/src/boot/auth.ts`, or their tests, stop — those are complete and tested. The single exception is a minor bug-fix that a later step surfaces; in that case, keep the change surgical and re-run the full test suite before moving on.

**Step 4 outcome (2026-07-11):** `requireEnv` now branches at its start on `resolveCredsSource(env)`. Legacy `env` branch is a verbatim copy of pre-Step-4 logic. New `db` branch requires `POSTGRES_URL` + `CONNECTOR_KEY_FILE` only. `resolveCredsSource` was widened to accept an optional env map (preferred path) so `requireEnv` stays a pure function of its input. Existing tests' `ALL_REQUIRED` fixture now carries `CONNECTOR_CREDS_SOURCE: "env"` — this preserves their intent (they were written for env-mode) since the default flipped to `db`. Do NOT revert that fixture change.

**Step 5 outcome (2026-07-11):** `auth.ts` now exports two functions with a shared `AuthResolution` return shape:
- `resolveAuthFromEnv(configAuthToken, env)` — verbatim rename of the old `resolveAuth`. Used by `bootFromEnv` in Step 6.
- `resolveAuthFromRow(row: ControllerRow)` — new. Used by `bootFromDb` in Step 6. Handles both `authMode` values, throws row-named errors on missing fields.

The `lifecycle.ts` call site was updated to `resolveAuthFromEnv` in Step 5 (`git diff 90d474f 7eef148 -- packages/connector/src/boot/lifecycle.ts` shows the exact edit). Step 6 wraps this call in a `bootFromEnv` function; the call itself does not change.

---


## TL;DR

Today: **tunnel creds live in three files on the connector filesystem** — `./.env` (bearer/OAuth), `./connector.yaml` (URL/name via `${}` interpolation), `./.connector-state.json` (registration token). Editing them requires shell access + a process restart. There is no UI to view, rotate, or replace them; a customer who lost their bearer has to `vim .env`, restart, and hope.

Target: **exactly one row in a Postgres table** carries every field needed to open the WSS tunnel. The inspector UI grows an "Add / edit tunnel credentials" form on localhost. Operators paste values there; the connector seals the secrets with a master key held in-process (K8s / Docker secret mount), persists them, and dials. Editing later goes through the same form — no shell, no restart *of the container*; the tunnel drops and redials with the new creds.

**Only one row.** The schema uses a `controllers` table with a PK `id` — but a `CHECK` gate constrains it to one row today. Phase-2 (multi-controller) removes the CHECK and adds the N-way fan-out described in [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md). Every schema decision here is chosen so the row model is Phase-2-ready.

## Prerequisites — DO THIS BEFORE GOING OFFLINE

The implementer will be offline while building. Every download must happen NOW, while online. Run these commands from the repo root exactly as written.

### 1. Cut a feature branch off `main`

All work in this plan lands on a **local-only** feature branch, NOT directly on `main`. Do this FIRST, before the npm install below — `npm install` mutates `package.json` and `package-lock.json`, and those changes must land on the feature branch.

```bash
cd /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim

# Verify clean working tree. Expected: "working tree clean".
# If dirty: stash (`git stash push -u`) or commit BEFORE proceeding —
# never run `git checkout` on a dirty tree.
git status

# Refresh main from origin, then cut the branch
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feature/env-to-db
```

Rules for this branch (do NOT deviate):
- **Local-only.** Do NOT `git push` this branch to origin at any point. Only `main` belongs on origin.
- **Keep it after merge.** Do NOT `git branch -d feature/env-to-db` after Step 13's merge. Leave the ref in place.
- **Branch name is `feature/env-to-db`.** Do not use a different name.

Acceptance: `git branch --show-current` prints `feature/env-to-db`; `git status` prints "nothing to commit, working tree clean."

### 2. Install npm dependencies (creates lockfile + workspace `node_modules`)

```bash
cd /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim
npm install --workspace @mcp-shim/connector \
  pg@^8.13.0 \
  libsodium-wrappers@^0.7.15
npm install --workspace @mcp-shim/connector --save-dev \
  @types/pg@^8.11.0 \
  @types/libsodium-wrappers@^0.7.14
```

Result: `packages/connector/package.json` gains four new dependencies; workspace-root `node_modules/` populated; `package-lock.json` updated. `pg` and `libsodium-wrappers` are pure JS (WASM binary embedded — no native compile step, offline-safe).

**Do NOT install `argon2`, `node-pg-migrate`, `sodium-native`, or `pgcrypto`.** They are deliberately out of scope (see §"Decisions").

Commit the lockfile bump so the feature branch has a clean starting point:

```bash
git add packages/connector/package.json package-lock.json
git commit -m "chore(env-to-db): add pg + libsodium-wrappers deps"
```

### 3. Pull the Postgres container image (only if the customer doesn't already have Postgres running)

The `enterprise-knowledge` bundle already runs Postgres in the deployed stack. For dev-loop testing of this plan, either:

- Reuse the already-running Postgres, OR
- Pull the pinned image now:

```bash
docker pull postgres:16-alpine
```

### 4. Generate a master-key file for local testing

The connector will look for `CONNECTOR_KEY_FILE=/path/to/master.key` on boot. Generate one now:

```bash
mkdir -p .local
head -c 32 /dev/urandom > .local/master.key
chmod 0600 .local/master.key
```

`.local/` should already be gitignored (verify with `git check-ignore .local/master.key`; if not, add `.local/` to `.gitignore` AND commit that change to the feature branch).

### 5. Verify the offline bundle

```bash
git branch --show-current                       # must print feature/env-to-db
npm ls pg libsodium-wrappers @types/pg @types/libsodium-wrappers --workspace @mcp-shim/connector
docker image inspect postgres:16-alpine >/dev/null && echo "postgres image OK"
test -s .local/master.key && echo "master.key OK ($(stat -f%z .local/master.key) bytes)"
```

All four lines must succeed. If any fail, the offline build will not work.

## Online ↔ Offline boundary — when you can disconnect

**You are ONLINE for `## Prerequisites` (steps 1–5 above), and you are OFFLINE for every implementation step after that** — except Step 13 (final merge to `main`), which is a git-only operation and needs no network. Concretely:

- **ONLINE required:** `## Prerequisites` steps 1–5 (branch cut + `git fetch`, npm install, docker pull, master.key generation, verification).
- **OFFLINE OK from here forward:** every step under `## Implementation task sequence` — coding, unit tests, integration tests against the locally-pulled Postgres, docs edits, and the final merge.

The task-sequence steps are annotated with an explicit `[ONLINE]` or `[OFFLINE OK]` badge. Do NOT invoke any of these tools during `[OFFLINE OK]` steps:

- WebFetch, WebSearch (would fail — no network)
- Context7 (`mcp__plugin_context7_context7__*`) (would fail)
- GitHub MCP tools (`mcp__plugin_github_github__*`) (would fail)
- `npm install` of packages not already in `node_modules/` (would fail — no registry)
- `docker pull` of any image (would fail — no registry)

If during an `[OFFLINE OK]` step you find yourself reaching for an external doc, STOP. Note the question in a comment or scratch file; the human operator will run the online lookup on your behalf. Do not guess.

### What is guaranteed available offline

- Every package under `node_modules/` (including READMEs and TypeScript typings — read from `node_modules/<pkg>/README.md` and `node_modules/<pkg>/index.d.ts` for API detail).
- Postgres container image `postgres:16-alpine` (`docker run` works offline once the image is local).
- Every file under this repo.
- The `.local/master.key` file you generated in Prerequisites step 4.

### Verifying you can run Postgres locally for tests

The `config-store` integration tests need a live Postgres. Before starting Step 3, bring one up:

```bash
docker run --rm -d --name mcp-shim-pg \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=mcp \
  -p 5432:5432 \
  postgres:16-alpine
```

And set (in your `.env` or the shell running tests):

```
POSTGRES_URL=postgres://postgres:dev@localhost:5432/mcp
POSTGRES_SCHEMA=mcp_connector
CONNECTOR_KEY_FILE=./.local/master.key
```

Tear down when done: `docker rm -f mcp-shim-pg`.

## Decisions — no ambiguity

Every question the plan previously left open is decided here. The implementer does NOT re-litigate any of these. If a decision here conflicts with body text further down, this section wins.

| # | Question | **Decision** |
|---|---|---|
| D1 | Feature flag `CONNECTOR_CREDS_SOURCE=env|db` for rollback? | **Yes. Ship the flag.** Env var `CONNECTOR_CREDS_SOURCE`, values `"env"` or `"db"`, default `"db"`. Value must be gated at **exactly one dispatch point** in `boot()` — see §"Feature flag — CONNECTOR_CREDS_SOURCE" for the exact shape. **Step 7 (delete `state.ts`) is CANCELLED** — `state.ts` and every legacy read/write path stay alive, guarded by `credsSource === "env"`. |
| D2 | `passphrase-kdf` master-key mode? | **Not in Phase-1.** Ship only the `file` mode. `CONNECTOR_KEY_SOURCE` env var is not read. `CONNECTOR_KEY_FILE` is always required. Skip Argon2 entirely. |
| D3 | `audit_log` table? | **Not in Phase-1.** Do NOT create the table. Do NOT write audit rows. Skip. |
| D4 | "Remove tunnel" button in the inspector? | **Not in Phase-1.** Ship only Add + Edit + Force re-registration. No Remove route, no Remove button. |
| D5 | `environment` column on the `controllers` row? | **Include the column.** Nullable TEXT. Populate from the form's "Environment" field. |
| D6 | `enabled` column? | **Include the column.** Default `TRUE`. No UI toggle in Phase-1 — always `TRUE`. |
| D7 | Boot ordering — DB before inspector, or inspector before DB? | **DB first.** Open the ConfigStore, resolve the master key, run migrations. THEN start the inspector. Fail-fast on DB unreachable or key mismatch. |
| D8 | Migration tooling — `node-pg-migrate` or hand-rolled? | **Hand-rolled, idempotent-every-boot.** One SQL block executed with `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` on every start. No versioning table. No down-migrations. See §"Migrations — the boot-time SQL block". |
| D9 | Session-creds route behavior? | **Unchanged.** Do not touch `session-creds-apply` / `session-creds-clear` / `env-keys` routes. |
| D10 | `.env` values auto-import to DB on first boot? | **No auto-import.** WARN and ignore per §Q10 of MULTI-ACCOUNT. |
| D11 | Delete `.connector-state.json` on first successful DB read? | **Yes.** After `getController()` returns a non-null row and the register-ack lands, `unlinkSync(defaultStatePath())` (best-effort; swallow errors). |
| D12 | Where do `POSTGRES_URL` and `CONNECTOR_KEY_FILE` come from at boot? | **From `.env`** (read via `dotenv/config` at entrypoint) OR the container env. Same layer as `LOG_LEVEL`, `INSPECTOR_PORT`. |
| D13 | What if the operator submits the inspector form but the tunnel dial fails? | **INSERT case**: roll back the row so the DB stays empty and the form re-renders with the error. **UPDATE case**: keep the row (operator can retry after fixing DNS/bearer). |
| D14 | What if `getController()` returns a row but the master key fingerprint mismatches `encryption_meta.key_fingerprint`? | **Fail-fast at boot** with the message: `"master key does not match the fingerprint recorded on first migration. Restore the original key or wipe the mcp_connector schema and re-add via the inspector."` Do NOT attempt to recover. |
| D15 | Schema name if `POSTGRES_SCHEMA` is unset? | **Default to `mcp_connector`.** |
| D16 | Pool size for `pg.Pool`? | **`max: 5`.** No tuning knob. |
| D17 | Where does the "Force re-registration" button live in the UI? | **Inside the Tunnel panel's readout, next to Edit.** Clears `registration_token_ct`, sends `goodbye`, redials. |
| D18 | What HTTP status codes for the new inspector routes? | **200** on success, **400** on payload validation error, **409** on tunnel-dial rejection during UPDATE (leaves row intact), **500** on DB error. |

## Feature flag — `CONNECTOR_CREDS_SOURCE`

**One env var, two code paths, one dispatch point.** The single hardest thing to get wrong here is the LLM scattering `if (credsSource === "db")` checks through the codebase. **Don't.** There is exactly one dispatch point, in `boot()`, and every difference between the two modes flows from it.

### The rule

```
Env var: CONNECTOR_CREDS_SOURCE
Values:  "env" | "db"     (exact match; case-sensitive; reject any other string at boot)
Default: "db"             (when the env var is unset or empty string)
```

### The one dispatch point — `packages/connector/src/boot/creds-source.ts`

Create this file:

```ts
import { envOptional } from "../env.js";

export type CredsSource = "env" | "db";

export function resolveCredsSource(): CredsSource {
  const raw = envOptional("CONNECTOR_CREDS_SOURCE") ?? "db";
  if (raw !== "env" && raw !== "db") {
    throw new Error(`CONNECTOR_CREDS_SOURCE must be "env" or "db"; got "${raw}"`);
  }
  return raw;
}
```

### The gate — `boot()` in `lifecycle.ts`

The `boot()` function's body becomes a two-branch dispatch:

```ts
export async function boot(): Promise<void> {
  const credsSource = resolveCredsSource();
  if (credsSource === "env") {
    await bootFromEnv();     // legacy code path — the entire pre-migration boot()
    return;
  }
  await bootFromDb();        // new code path — Step 6 spec
}
```

`bootFromEnv` is the **verbatim old `boot()` body** — do NOT modify it in any way. `bootFromDb` is the new code path per Step 6. They live side-by-side in `lifecycle.ts` (or one of them extracted to a sibling file — implementer's choice; the caller-side interface is what matters).

### What each mode requires

Different env vars, different files:

| Mode | Required env | Reads | Writes |
|---|---|---|---|
| `env` | `CONTROLLER_URL`, `CONNECTOR_NAME`, `TUNNEL_AUTH_TOKEN` **or** `OAUTH_*` | `.env`, `connector.yaml` `tunnel:` block, `.connector-state.json` | `.connector-state.json` |
| `db` | `POSTGRES_URL`, `CONNECTOR_KEY_FILE` | `controllers` row in Postgres | `controllers` row in Postgres |

`requireEnv()` inspects `resolveCredsSource()` at its start and branches: the two required-var sets are **mutually exclusive**. An operator running in `env` mode never needs `POSTGRES_URL`; an operator running in `db` mode never needs `CONTROLLER_URL`. See Step 4 for the exact `requireEnv` shape.

### What the `env` mode preserves (do NOT delete)

Because the flag exists, every file the legacy path reads/writes STAYS in the tree:

- `packages/connector/src/state.ts` — `readState` / `writeState` / `clearRegistrationToken(path)` all remain. **Do not delete this file** (Step 7 is cancelled).
- The `tunnel:` block in `packages/connector/src/config.ts`'s zod schema stays. In `env` mode it's required; in `db` mode it's optional-with-WARN (Step 8).
- `.env.example` at the repo root keeps BOTH the legacy per-controller keys AND the new keys, clearly separated (Step 10 spells out the exact shape).
- `resolveAuth(configAuthToken)` — the OLD signature stays as an overload/alternate export named `resolveAuthFromEnv`. The NEW signature `resolveAuthFromRow(row)` is what `bootFromDb` calls. Step 5 spells out both.

### Removal timeline (Step 14)

The flag ships for **exactly one release cycle** and is removed in a follow-up PR (Step 14 in the task sequence). Removing the flag = deleting the `env` branch, deleting `state.ts`, deleting `resolveAuthFromEnv`, dropping the `tunnel:` block from the yaml schema, and stripping legacy keys from `.env.example`. Step 14 is a separate PR — not part of the initial migration.

### What NOT to do

- Do NOT read `CONNECTOR_CREDS_SOURCE` anywhere except in `resolveCredsSource()`.
- Do NOT branch on it in `resolveAuth`, `inspector/server.ts`, `config-store/index.ts`, or any other module. Each of those modules is used by exactly one mode; the mode-agnostic modules (`config.ts`, `logger.ts`, etc.) don't need to know.
- Do NOT add a third value (`"auto"`, `"both"`, `"fallback"`). Two values, that's it.

## Motivation — why this now, why one account first

1. **The "I lost my `ts_` bearer" support call.** Today the recovery is: `ssh` to the container host / `kubectl exec`, edit `.env`, restart. If the connector is behind a bastion, that's 15 minutes of downtime for a paste-in-a-form operation.
2. **The rotation story is unnatural.** Rotating a bearer is a 3-step process: paste new value in `.env` on disk → SIGHUP or restart → confirm. There's no UI signal that the rotation succeeded until you watch logs. Moving to the DB lets the inspector show "connected with credential minted 2s ago."
3. **Storage-at-rest hygiene.** `.env` values sit in `/proc/<pid>/environ` and often in shell history / editor swap files. Sealing them in Postgres with libsodium raises the bar for accidental exfiltration.
4. **This is Phase-1 of MULTI-ACCOUNT.** The N-controller design already resolved every "how do we store creds" question — DB engine, encryption primitive, key sourcing, migration policy. Landing the one-row version now lets us prove out the storage layer + inspector paste flow *before* piling the fan-out on top. Two smaller PRs, each independently verifiable.
5. **Q10 (from MULTI-ACCOUNT) applies here too.** No auto-import from `.env`. The transition is explicit: operator boots once with legacy `.env`, sees a WARN, opens the inspector, pastes values, clears the `.env`. Auto-import is a false economy — it silently normalizes stale creds into a new source of truth and creates a "why is my rotated value not applying" support tail. We take the short-term pain of one manual paste per customer for a clean cutover.

## Non-goals — what this plan explicitly does NOT do

- **Multi-controller fan-out.** One tunnel row today. Schema is Phase-2-friendly but the code paths that spawn N tunnels, split the supervisor keying, and filter manifests per-controller do NOT ship here. See [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md).
- **Shared-MCP cred vault.** Per-MCP runtime env for shared MCPs stays in `dir/.env` on the connector filesystem, matching MULTI-ACCOUNT §Q4 resolution. The DB stores **tunnel identity + tunnel creds only** — no `shared_mcp_creds` table, no "paste shared MCP creds" flow.
- **Session-creds redesign.** The existing `POST /mcp/session-creds-apply` loopback route stays exactly as it is today (in-memory, 12h TTL, never persisted). This plan doesn't touch it.
- **New wire-protocol frames.** The connector ↔ controller wire is unchanged. The controller has no visibility that creds moved from `.env` to a DB; it still receives the same register frame with the same bearer on the WS handshake and the same registrationToken in the register frame body.
- **HA / clustering.** Still one connector process. Postgres provides durability, not availability of the connector process itself.
- **Cred rotation via controller push.** Rotating the WS-handshake bearer is a **customer-side** operation (operator pastes into the inspector); the controller-minted `ts_` value is what gets pasted. No new "rotate" wire frame.

## Current state — where the single-file assumption is baked in

Enumerating the load-bearing single-file assumptions in the codebase (grep-able concepts):

| Surface | Current shape | This plan's target |
|---|---|---|
| `./.env` at CWD | `CONTROLLER_URL`, `CONNECTOR_NAME`, `TUNNEL_AUTH_TOKEN` or `OAUTH_*` | Values migrate to `controllers` row. Env keys removed from `.env.example`; boot logs WARN if present. |
| `./connector.yaml` `tunnel:` block | `controller_url: ${CONTROLLER_URL}`, `name: ${CONNECTOR_NAME}`, `auth_token: ${TUNNEL_AUTH_TOKEN:-}` | `tunnel:` block **removed** from yaml. Boot reads tunnel identity from DB row, not yaml. |
| `./.connector-state.json` at CWD | `{ registrationToken }` | `registration_token_ct` column on the DB row. State file **deleted** on first successful DB read. |
| [`src/boot/require-env.ts`](packages/connector/src/boot/require-env.ts) `requireEnv()` | Checks `CONTROLLER_URL`, `CONNECTOR_NAME`, auth-posture env vars | Checks only global-connector-config env (`POSTGRES_URL`, `CONNECTOR_KEY_FILE`, etc.). Per-controller vars removed. |
| [`src/boot/auth.ts`](packages/connector/src/boot/auth.ts) `resolveAuth(configAuthToken)` | Reads `TUNNEL_AUTH_TOKEN` from env / yaml + `OAUTH_*` from env | Reads the row from DB, decrypts fields, returns the same `AuthResolution` shape. Signature changes; call site is one place in `boot()`. |
| [`src/boot/lifecycle.ts`](packages/connector/src/boot/lifecycle.ts) `boot()` | Loads yaml → `resolveAuth` → `readState` → `new TunnelClient(url, token, name, provider)` | Loads yaml (unchanged: still owns `mcp_servers` + `policy`) → opens DB → reads controller row → `new TunnelClient(...)`. |
| [`src/tunnel/client.ts`](packages/connector/src/tunnel/client.ts) `TunnelClient` ctor | `(url, authToken, connectorName, authProvider)` | **Unchanged.** The DB-vs-env distinction is invisible to the transport. |
| [`src/state.ts`](packages/connector/src/state.ts) `readState` / `writeState` / `clearRegistrationToken` | File-based read/write of `.connector-state.json` | **Preserved under `env` mode** for the flag's lifetime. `db` mode never reads it; the registration token lives in the DB row instead. Deleted in Step 14 when the flag is removed. |
| [`src/inspector/server.ts`](packages/connector/src/inspector/server.ts) routes | Session-creds paste (write-only), MCP status, webhook URLs, reconnect | New routes: `POST /internal/tunnel/creds` (upsert), `GET /internal/tunnel/config` (read metadata — never values), `POST /internal/tunnel/reconnect` (already exists as `/reconnect`; the new form-submit reuses it). |
| Inspector UI [`public/app.js`](packages/connector/public/app.js) | Renders header + panels; no config-edit form | New "Tunnel" panel with URL / name / auth-mode / paste-secret form. Renders row's metadata (mode, connect state, last-connected timestamp). |

All of these are localized; the surface area is broad but shallow.

## Target shape

### Boot flow — what changes

**Before:**
```
1. requireEnv()                      # CONTROLLER_URL / CONNECTOR_NAME / auth-posture
2. loadConfig(yaml)                   # yaml owns tunnel.* + mcp_servers + policy
3. resolveAuth(config.tunnel.auth_token)
4. readState(.connector-state.json)  # registrationToken
5. new TunnelClient(url, token, name, provider)
6. dial → register → persist token back to state file
```

**After:**
```
1. requireEnv()                      # POSTGRES_URL / CONNECTOR_KEY_FILE only (per-controller vars removed)
2. openConfigStore(POSTGRES_URL)     # fail-fast if unreachable
3. resolveMasterKey(CONNECTOR_KEY_FILE)  # 32 raw bytes; fail-fast if absent / wrong mode
4. runMigrations()                   # idempotent; no-op on already-current schema
5. loadConfig(yaml)                  # yaml owns mcp_servers + policy only (tunnel: block gone)
6. row = configStore.getController() # exactly one row; if missing → "empty state" boot
7. IF row exists:
      auth = decryptControllerRow(row, masterKey)   # returns AuthResolution + tunnel URL/name
      state = { registrationToken: row.registrationToken }
      new TunnelClient(auth.url, auth.token, auth.name, auth.provider)
      dial → register → persist any fresh token back to the row
   ELSE:
      Inspector starts as normal; header renders "No tunnel configured — add one at http://localhost:9090/#tunnel"
      Shared MCPs still spawn and serve inspector-driven test calls
      Boot process does NOT exit; waits for the operator to paste values in the UI
```

**Key property:** empty-DB is a valid boot state. Shared MCPs still run (customer can smoke-test drop-ins locally); the tunnel simply doesn't dial. This is deliberate — the alternative ("refuse to boot without a controller row") makes the "just installed, want to configure via UI" first-run experience impossible. Same trade-off MULTI-ACCOUNT makes for Phase-2 (§"First-run experience — no legacy import").

### Inspector as the write path

Every mutation of the controller row goes through the localhost inspector. Concretely:

1. **Add tunnel** (empty DB, first-run). Operator opens `http://localhost:9090/`, clicks **Configure tunnel**, fills in a form (URL, connector name, auth mode, secret material), submits. Server-side:
   - Validate payload shape (URL parses, name non-empty, auth-mode matches secret shape).
   - Seal the bearer / OAuth-secret with the master key.
   - `INSERT INTO controllers` (or `INSERT ... ON CONFLICT DO UPDATE` since only one row is legal).
   - Instantiate `TunnelClient` with the decrypted values, dial.
   - On successful register-ack, persist any minted `registrationToken` back to the row.
   - On failed dial (bad bearer, DNS error): row is either rolled back (`INSERT` case) or kept (`UPDATE` case, so the operator can retry after fixing DNS). Form re-renders with error.
2. **Edit tunnel** (row exists). Same form pre-filled with **non-secret fields** (URL, name, auth mode, whether a bearer / OAuth secret is set — but never the values). Operator edits URL or pastes a new bearer. Submit → seal (if secret provided) → `UPDATE` → send `goodbye { reason: "credential-rotated" }` on the live tunnel → close → immediately redial with new values.
3. **Force re-registration.** Button next to the row that clears `registration_token_ct` and redials. Same effect as `rm .connector-state.json` today.
4. **Remove tunnel.** Confirmation modal; deletes the row. Tunnel closes with `goodbye { reason: "controller-removed" }`. Empty-state UI reappears. (Optional today — nice-to-have; not blocking.)

**Loopback-only.** Every new route lives on the inspector's existing 127.0.0.1 bind. The trust boundary is unchanged. The inspector's file explicitly enforces `server.listen(port, "127.0.0.1", …)`; no route added by this plan may bind to `0.0.0.0` or accept a `--host` argument.

**Write-only for secrets.** The `GET /internal/tunnel/config` route returns URL, name, auth-mode, presence flags for the bearer / OAuth secret, `registrationTokenLen`, connection state, last-connected timestamp. It never returns cleartext bearer / OAuth secret / registration token values. Mirrors the existing session-creds property: "there is no GET /mcp/session-creds and there will never be one" — same rule applied to tunnel creds.

### `.env` after this change

`.env` keeps only global connector config:

```
LOG_LEVEL=info
INSPECTOR_PORT=9090
MCP_BASE_PORT=7100
MCP_DROPIN_DIR=./mcp/local

POSTGRES_URL=postgres://user:pass@host:5432/mcp
POSTGRES_SCHEMA=mcp_connector

CONNECTOR_KEY_FILE=/run/secrets/mcp-connector/master.key
```

**Removed** from `.env.example`:
- `CONTROLLER_URL`
- `CONNECTOR_NAME`
- `TUNNEL_AUTH_TOKEN`
- `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `OAUTH_TOKEN_URL`

If any of these are present in an inherited `.env` on boot, log a WARN naming them: `"legacy per-controller env vars ignored; add your controller via the inspector at http://localhost:9090/"`. Do NOT auto-import. See §"Migration path" for the transition story.

### `connector.yaml` after this change

`connector.yaml` keeps:
- `mcp_servers:` — shared Type 1 hand-written + Type 3 bundle entries. Unchanged.
- `policy:` — heartbeat, reconnect, tool-timeout knobs. Unchanged.

**Removed:**
- The entire `tunnel:` block. `controller_url` / `name` / `auth_token` / `environment` all move to the DB row (`environment` becomes an optional column).

If `tunnel:` is present in an inherited yaml on boot, log a WARN naming it: `"legacy 'tunnel:' block in connector.yaml ignored; tunnel identity is now managed in the DB. Add your controller via the inspector."` Do NOT auto-import.

## Database design

### Why Postgres — reuse the enterprise-knowledge instance

Same rationale as MULTI-ACCOUNT §"Why Postgres" — the customer deployment already runs Postgres for the `enterprise-knowledge` bundle. Adding a `mcp_connector` schema costs nothing operationally. Zero new infrastructure; standard migrations via `node-pg-migrate`.

Connection config via env:
- `POSTGRES_URL` (preferred single-var: `postgres://user:pass@host:5432/dbname`)
- Or split form: `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DATABASE` / `POSTGRES_USER` / `POSTGRES_PASSWORD`
- `POSTGRES_SCHEMA` (default `mcp_connector`) — dedicated namespace so connector tables don't collide with llamaIndex's tables in the same database.

**Boot dependency.** Postgres must be up before the connector boots. Fail-fast on unreachable DB. Same gate as the enterprise-knowledge bundle enforces today.

**Dependency footprint:** `pg` (async driver, single dep) + `node-pg-migrate` (dev-dep) + `libsodium-wrappers` (already pulled by the wire-encryption plan).

### Migrations — the boot-time SQL block

Executed on every boot inside a single transaction. Idempotent by construction — `CREATE ... IF NOT EXISTS` everywhere. No versioning table, no down-migrations, no `node-pg-migrate` dependency.

> **Implementation deviation (2026-07-11):** the plan originally called for a static `SCHEMA_SQL` constant. Because `POSTGRES_SCHEMA` is configurable per decision D15 (default `mcp_connector`), the DDL is instead exported as `schemaSql(schema: string): string` from `config-store/schema.ts`. The function validates the identifier and interpolates it into every `CREATE TABLE` / `CREATE INDEX` clause (fully qualifying the object). Execute via `pool.query(schemaSql(schema))`.

```sql
CREATE SCHEMA IF NOT EXISTS ${schema};
SET search_path TO ${schema};

-- Encryption metadata. Exactly one row, id=1. Populated on first boot.
CREATE TABLE IF NOT EXISTS ${schema}.encryption_meta (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    key_fingerprint   TEXT NOT NULL,             -- SHA-256 hex of the master key
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Controllers. Phase-1: exactly one row, enforced by the unique index below.
CREATE TABLE IF NOT EXISTS ${schema}.controllers (
    id                     TEXT PRIMARY KEY,         -- UUID minted in JS on insert (crypto.randomUUID())
    name                   TEXT NOT NULL UNIQUE,     -- human-friendly ("twilio-prod")
    controller_url         TEXT NOT NULL,            -- https://... (not encrypted)
    connector_name         TEXT NOT NULL,            -- goes into WS X-Connector-Name header
    environment            TEXT,                     -- nullable, e.g. "dev" | "prod"
    auth_mode              TEXT NOT NULL CHECK (auth_mode IN ('static-bearer', 'oauth2-cc')),
    tunnel_auth_token_ct   BYTEA,                    -- sealed; NULL for oauth2-cc
    oauth_client_id        TEXT,                     -- not secret
    oauth_client_secret_ct BYTEA,                    -- sealed; NULL for static-bearer
    oauth_token_url        TEXT,
    registration_token_ct  BYTEA,                    -- sealed; may be NULL before first register-ack
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_connected_at      TIMESTAMPTZ,
    last_disconnect_reason TEXT
);

-- Phase-1 gate: at most one row. Phase-2 will DROP this index.
CREATE UNIQUE INDEX IF NOT EXISTS one_controller_only ON ${schema}.controllers ((TRUE));
```

**No `audit_log` table** in Phase-1 (D3). **No `key_source` column** in `encryption_meta` — only file mode is supported (D2).

The `one_controller_only` unique index is the single line separating Phase-1 from Phase-2. Phase-2's migration drops it.

### Fingerprint bootstrap

On the very first boot (fresh schema), `encryption_meta` is empty. The migration block above creates the table but does not insert. The `ConfigStore.resolveMasterKey()` bootstrap step is:

```
row = SELECT key_fingerprint FROM encryption_meta WHERE id=1
IF row IS NULL:
    INSERT INTO encryption_meta (id, key_fingerprint) VALUES (1, sha256(masterKey))
ELSE IF row.key_fingerprint != sha256(masterKey):
    THROW "master key does not match the fingerprint recorded on first migration ..."
```

Fingerprint is SHA-256 hex of the 32-byte master key bytes.

### What's NOT in the DB (Phase-1)

- **MCP definitions.** `connector.yaml`'s `mcp_servers[]` stays on disk. Controller-pushed Type 2 entries stay in RAM per the existing `McpConfigCoordinator` design.
- **Per-MCP creds** (shared or otherwise). `dir/.env` stays authoritative. Same as MULTI-ACCOUNT §Q4.
- **Approval state.** RAM-only; controller replays `mcp-enable` on register-ack.
- **Session creds.** In-memory, 12h TTL, never persisted.
- **Webhook allocations.** RAM-only in the connector.

The persistence philosophy is unchanged from MULTI-ACCOUNT: **the DB holds tunnel identity + tunnel creds only.** Everything downstream stays on-disk (`dir/.env`) or in RAM (controller-authoritative state).

### Encryption — file mode only

`CONNECTOR_KEY_FILE` is required. Read exactly 32 bytes from the path. Enforce file mode `0600` (throw if the file's mode has any bit outside `0600` set for group/other).

**Encryption primitive:** libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305). 24-byte random nonce prepended to ciphertext; each `*_ct` column stores `nonce || ciphertext`.

**Key rotation** is out of scope for Phase-1. If the master key changes, the fingerprint check throws at boot (D14) and the operator wipes the `mcp_connector` schema (`DROP SCHEMA mcp_connector CASCADE`) and re-adds the controller via the inspector.

## Code changes

### New modules

Create these files, in this order.

#### `packages/connector/src/config-store/schema.ts` ✅ shipped

```ts
export function schemaSql(schema: string): string { /* returns DDL with ${schema} interpolated */ }
```

Single exported function. Validates identifier against `/^[A-Za-z_][A-Za-z0-9_]*$/` before interpolation (pg has no built-in identifier quoter and the schema name comes from env). Callers pass the resolved schema name from `POSTGRES_SCHEMA` (default `mcp_connector`).

#### `packages/connector/src/config-store/master-key.ts`

```ts
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { envString } from "../env.js";

export interface MasterKey {
  bytes: Buffer;         // exactly 32 bytes
  fingerprint: string;   // sha256 hex
}

export function resolveMasterKey(): MasterKey {
  const path = envString("CONNECTOR_KEY_FILE", "");
  if (!path) throw new Error("CONNECTOR_KEY_FILE is required (path to a 32-byte master key file, mode 0600).");
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if (mode & 0o077) throw new Error(`CONNECTOR_KEY_FILE at ${path} has mode ${mode.toString(8)}; must be 0600.`);
  const bytes = readFileSync(path);
  if (bytes.length !== 32) throw new Error(`CONNECTOR_KEY_FILE at ${path} must be exactly 32 bytes (got ${bytes.length}).`);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  return { bytes, fingerprint };
}
```

#### `packages/connector/src/config-store/seal.ts` ✅ shipped

```ts
import { createRequire } from "node:module";
import type SodiumType from "libsodium-wrappers";

// libsodium-wrappers@0.7.15 ships a broken ESM entry (its
// dist/modules-esm/libsodium-wrappers.mjs imports a sibling ./libsodium.mjs
// that doesn't exist in that folder). createRequire uses the CJS loader
// which walks node_modules correctly. Sanctioned CJS-under-ESM pattern per
// CLAUDE.md §Workspaces. If a future dep-bump fixes the ESM entry, this
// shim can be removed.
const requireCjs = createRequire(import.meta.url);
const sodium = requireCjs("libsodium-wrappers") as typeof SodiumType;

// One-time init before any seal/open call. The connector calls this once at boot.
export async function initSodium(): Promise<void> {
  await sodium.ready;
}

// Layout: [24-byte nonce][ciphertext]
export function seal(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES));
  const ct = Buffer.from(sodium.crypto_secretbox_easy(plaintext, nonce, key));
  return Buffer.concat([nonce, ct]);
}

export function open(sealed: Buffer, key: Buffer): Buffer {
  const nonce = sealed.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
  const ct = sealed.subarray(sodium.crypto_secretbox_NONCEBYTES);
  const pt = sodium.crypto_secretbox_open_easy(ct, nonce, key);
  if (!pt) throw new Error("seal-open failed: authentication tag mismatch (tampered ciphertext or wrong key).");
  return Buffer.from(pt);
}
```

#### `packages/connector/src/config-store/index.ts`

```ts
import pg from "pg";
import { envString, envOptional } from "../env.js";
import { SCHEMA_SQL } from "./schema.js";
import { MasterKey } from "./master-key.js";
import { seal, open } from "./seal.js";

export interface ControllerRow {
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken: string | null;    // decrypted; null when authMode="oauth2-cc"
  oauthClientId: string | null;
  oauthClientSecret: string | null;  // decrypted
  oauthTokenUrl: string | null;
  registrationToken: string | null;  // decrypted; null before first register-ack
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt: Date | null;
  lastDisconnectReason: string | null;
}

export interface ControllerInput {
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken?: string;        // required when authMode="static-bearer"
  oauthClientId?: string;          // required when authMode="oauth2-cc"
  oauthClientSecret?: string;      // required when authMode="oauth2-cc"
  oauthTokenUrl?: string;          // required when authMode="oauth2-cc"
}

export class ConfigStore {
  constructor(private pool: pg.Pool, private schema: string, private key: MasterKey) {}

  static async open(masterKey: MasterKey): Promise<ConfigStore> {
    const url = envString("POSTGRES_URL", "");
    if (!url) throw new Error("POSTGRES_URL is required.");
    const schema = envOptional("POSTGRES_SCHEMA") ?? "mcp_connector";
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    await pool.query(schemaSql(schema));  // function, not constant — see gotcha #1 in Resume Point section
    // Fingerprint check
    const { rows } = await pool.query(`SELECT key_fingerprint FROM ${schema}.encryption_meta WHERE id=1`);
    if (rows.length === 0) {
      await pool.query(`INSERT INTO ${schema}.encryption_meta (id, key_fingerprint) VALUES (1, $1)`, [masterKey.fingerprint]);
    } else if (rows[0].key_fingerprint !== masterKey.fingerprint) {
      throw new Error("master key does not match the fingerprint recorded on first migration. Restore the original key or wipe the mcp_connector schema and re-add via the inspector.");
    }
    return new ConfigStore(pool, schema, masterKey);
  }

  async getController(): Promise<ControllerRow | null> { /* SELECT * FROM controllers LIMIT 1; open() each *_ct */ }
  async upsertController(input: ControllerInput): Promise<ControllerRow> { /* validate, seal, INSERT ... ON CONFLICT DO UPDATE */ }
  async updateRegistrationToken(id: string, token: string): Promise<void> { /* seal + UPDATE */ }
  async clearRegistrationToken(id: string): Promise<void> { /* UPDATE ... SET registration_token_ct = NULL */ }
  async recordConnect(id: string): Promise<void> { /* UPDATE ... SET last_connected_at = now() */ }
  async recordDisconnect(id: string, reason: string): Promise<void> { /* UPDATE ... SET last_disconnect_reason = $2 */ }
  async close(): Promise<void> { await this.pool.end(); }
}
```

`upsertController` uses `INSERT ... ON CONFLICT (id) DO UPDATE`. To keep "one row only", the row's `id` is generated deterministically as ULID **only for INSERT**; UPDATE re-uses the existing row's id (SELECT it first). The `one_controller_only` unique index enforces the invariant at the DB level.

Row-id generation: use `crypto.randomUUID()` (native, no dep) — the plan says ULID but UUID satisfies the same "opaque unique string" contract with zero deps.

#### `packages/connector/src/inspector/tunnel-routes.ts`

Handlers for four routes, mounted under `/internal/tunnel/*`:

| Method + Path | Purpose | Request | Response |
|---|---|---|---|
| `GET /internal/tunnel/config` | Read metadata (never values) | none | `{ configured: boolean, row?: TunnelConfigSummary }` |
| `POST /internal/tunnel/creds` | Upsert row + dial | `ControllerInput`-shaped JSON | `200 {ok:true}` or `400/409/500 {ok:false,error}` |
| `POST /internal/tunnel/force-reregister` | Clear token, redial | none | `200 {ok:true}` |
| `POST /internal/tunnel/reconnect` | Alias of existing `POST /reconnect` — not new; the UI's "reconnect" button reuses the existing handler | none | same as `/reconnect` |

`TunnelConfigSummary` shape:
```ts
{
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  hasTunnelAuthToken: boolean;      // never the value
  hasOauthClientSecret: boolean;    // never the value
  oauthClientId: string | null;
  oauthTokenUrl: string | null;
  hasRegistrationToken: boolean;
  registrationTokenLen?: number;    // length only, not the value
  lastConnectedAt: Date | null;
  lastDisconnectReason: string | null;
}
```

**No `Buffer` / bearer / OAuth-secret / registration-token values ever appear in the JSON response.** The leak-channel test pins this.

Wire the routes in `inspector/server.ts` alongside the existing routes. The route module receives constructor-injected callbacks (from `boot()`): `configStore: ConfigStore`, `dialTunnel(row): Promise<void>`, `cycleTunnel(reason): Promise<void>`.

### Modules that change

**`src/boot/auth.ts`** — `resolveAuth` signature changes from `(configAuthToken: string | undefined, env)` to `(row: ControllerRow, masterKey: Buffer)`. Same `AuthResolution` shape returned. The internal branching is the same — OAuth2 iff `row.auth_mode === "oauth2-cc"`, else static-bearer. The pure-function property is preserved; a unit test just supplies a fake row.

**`src/boot/require-env.ts`** — removes checks for `CONTROLLER_URL`, `CONNECTOR_NAME`, `TUNNEL_AUTH_TOKEN`, `OAUTH_*`. Adds:
- `POSTGRES_URL` OR (`POSTGRES_HOST` + `POSTGRES_DATABASE` + `POSTGRES_USER`) — split form.
- `CONNECTOR_KEY_FILE` (or `CONNECTOR_KEY_PASSPHRASE` when `CONNECTOR_KEY_SOURCE=passphrase-kdf`).

Consolidated error message names all missing pieces in one pass, per the existing require-env style.

**`src/boot/lifecycle.ts`** — the `boot()` function edits:
- Insert the `openConfigStore` + `resolveMasterKey` + `runMigrations` calls before the yaml load.
- After yaml load, replace `resolveAuth(config.tunnel.auth_token)` + `readState(...)` with:
  ```
  const row = await store.getController()
  if (!row) {
      // Empty-DB boot: start inspector, wait for form submit.
      startInspector(inspectorPort, inspector)
      log.info("no controller row; waiting for inspector configuration at http://localhost:9090/")
      // Shared MCPs still boot and are reachable via inspector test-tool calls.
      return
  }
  const auth = resolveAuth(row, masterKey)
  const registrationToken = row.registration_token_ct
      ? open(row.registration_token_ct, masterKey).toString("utf8")
      : undefined
  ```
- Replace `writeState({...})` on register-ack success with `store.updateRegistrationToken(row.id, token, masterKey)`.
- Replace `clearRegistrationToken()` on register-rejected with `store.clearRegistrationToken(row.id)`.
- Replace the yaml-tunnel-block reads (`config.tunnel.controller_url`, `config.tunnel.name`, `config.tunnel.environment`) with the equivalent row fields.

**`src/config.ts`** — the zod schema for `connector.yaml` drops the `tunnel:` block. `loadConfig` returns `{ mcp_servers, policy }` only. An inherited `tunnel:` block is accepted (zod `.strict()` → `.strip()` for that key) but logged as `"legacy 'tunnel:' block in connector.yaml ignored; tunnel identity is now in the DB"`.

**`src/inspector/server.ts`** — grow the `InspectorState` union with a `TunnelConfig` snapshot that mirrors the row's non-secret fields (URL, name, auth mode, presence flags, connect state, last-connected timestamp). Add SSE event `{ kind: "tunnel-config"; tunnel: TunnelConfigSummary }` alongside existing events. New handler bloc:
```
if (path === "/internal/tunnel/config" && req.method === "GET") return respondJson(res, tunnelConfigSummary())
if (path === "/internal/tunnel/creds"  && req.method === "POST") return handleUpsert(req, res)
if (path === "/internal/tunnel/force-reregister" && req.method === "POST") return handleForceReregister(res)
if (path === "/internal/tunnel/remove" && req.method === "POST") return handleRemove(res)
```
The upsert handler is where the DB write + tunnel-cycle happens: parse JSON body, validate, seal, `configStore.upsertController(...)`, then send `goodbye` + close on the live tunnel (if any) and immediately redial with the new row. On dial success, respond `200 {ok:true}`. On dial failure, respond `4xx` with the error and leave the row as-is (operator can retry after fixing DNS / bearer).

**`public/app.js` + `public/index.html` + `public/style.css`** — new "Tunnel" panel in the left column, above the existing "MCP Servers" panel. Two rendering modes:

- **Empty state** (no row): a centered CTA block: **"Configure your tunnel"** + a **Configure tunnel** button that opens a modal with the form.
- **Configured state**: two-column readout — `Controller URL: https://…` / `Connector name: …` / `Auth mode: static-bearer` / `Bearer: <set>` / `Registration: bound (token len=84)` / `Last connected: 2s ago` — plus three buttons: **Edit**, **Force re-registration**, **Remove**.

The **Edit / Configure** modal is a single form with radio-group `Auth mode: [○ Static bearer  ○ OAuth2 client_credentials]` and mode-conditional inputs:
- **Static bearer:** one password-field labeled `Tunnel auth token (ts_… value from the controller's Tunnel Security row)`.
- **OAuth2:** `client_id` (text), `client_secret` (password), `token_url` (text).

Always-visible fields: `Controller URL` (text), `Connector name` (text, help: "must match the controller-side Tunnel Security row name — case-sensitive"), `Environment` (optional text). Submit button: **"Save & connect"** (edit mode: **"Save & reconnect"**).

Secrets: `<input type="password" autocomplete="off">`; the panel's readout NEVER shows the value, only a `<set>` / `<not set>` badge. When editing, the password field is empty by default; leaving it empty keeps the existing sealed value (server-side: don't overwrite `*_ct` if the request omits the field).

`★ Insight ─────────────────────────────────────`
- The empty-password-means-keep-existing convention (mirrored from every UNIX passwd form since 1978) avoids the "operator opens the edit modal, sees the password field is blank, panics" UX. The readout badge is what confirms the value is still there.
- Rendering the URL / name in the modal (not just in the readout) matters because operators frequently edit those alongside the bearer during controller migrations. Splitting into two forms doubles clicks for no gain.
`─────────────────────────────────────────────────`

### Modules that get deleted (Step 14 only — NOT this migration)

Nothing is deleted in Steps 1–12. Every legacy file (`state.ts`, the `tunnel:` block in the yaml schema, `resolveAuthFromEnv`, legacy `.env.example` keys) is preserved for the flag's lifetime. Step 14, run as a separate PR one release later, is where deletions happen — see §"Step 14 — Remove the feature flag" in the implementation sequence.

Under `db` mode, when `bootFromDb` sees a leftover `.connector-state.json` on disk *after* a successful register-ack against the DB row, it deletes the file silently (best-effort; swallow ENOENT). That's the one-shot migration hook per §"Migration path" — it removes the stale file so an accidental future flip back to `env` mode doesn't re-present a mismatched token. The file `state.ts` itself stays.

### Wire protocol — unchanged

The controller side is completely unaware of this change. The connector still:
- Sends `Authorization: Bearer <value>` + `X-Connector-Name: <name>` on the WS upgrade.
- Sends the same `register { manifest, name, registrationToken? }` frame body.
- Receives the same `register-ack { registrationToken? }`.

Only difference: the connector now pulls values from a DB row instead of `.env` + yaml + state file. Wire format authority ([`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md)) needs no edits.

## Migration path — from `.env` to the DB

Aligned with MULTI-ACCOUNT §Q10: **no auto-import.** The customer transitions once, manually. Concretely:

1. **Customer upgrades the connector image** to a version that includes this plan.
2. **First boot on the new version:**
   - `requireEnv()` no longer requires `CONTROLLER_URL` / `CONNECTOR_NAME` / bearer. It DOES require `POSTGRES_URL` + `CONNECTOR_KEY_FILE`. If those aren't set, boot fails with a consolidated error naming them + linking to the deploy guide.
   - Postgres migrations run; schema created; `encryption_meta` populated with the master-key fingerprint.
   - `getController()` returns `null` → empty-DB boot; inspector renders "Configure your tunnel."
   - WARN logged if inherited `.env` still has legacy per-controller keys: `"legacy per-controller env vars ignored (CONTROLLER_URL, CONNECTOR_NAME, TUNNEL_AUTH_TOKEN); add your controller via the inspector at http://localhost:9090/"`.
   - WARN logged if inherited yaml has `tunnel:` block: `"legacy 'tunnel:' block in connector.yaml ignored; tunnel identity is now in the DB"`.
3. **Operator opens `http://localhost:9090/`** (via port-forward / bastion) and clicks **Configure tunnel**.
4. Operator **copy-pastes** from their existing `.env` into the form. Submits.
5. Connector seals + persists + dials. On successful register-ack, the row's `registration_token_ct` populates.
6. **Cleanup** (customer's own step, on their own timeline):
   - Remove `CONTROLLER_URL`, `CONNECTOR_NAME`, `TUNNEL_AUTH_TOKEN`, `OAUTH_*` from `.env` on disk.
   - Remove the `tunnel:` block from `connector.yaml`.
   - `rm .connector-state.json` (the connector already deletes it on boot if found alongside a valid DB row; the manual `rm` is belt-and-suspenders).

**Rollback story:** for one release cycle after this plan lands, the code path that reads `.env` / yaml `tunnel:` block / `.connector-state.json` should be kept behind a feature flag `CONNECTOR_CREDS_SOURCE=env|db` (default `db`). If a customer hits a blocking bug post-upgrade, they set `CONNECTOR_CREDS_SOURCE=env` and revert to the file-based path. Remove the flag one release later once the DB path is proven stable across the customer base. This is a temporary belt for a load-bearing migration; the flag is not intended to be a permanent config knob.

## First-run experience

**Fresh install, no `.env` legacy:**
1. Customer starts the connector container. `POSTGRES_URL` and `CONNECTOR_KEY_FILE` are set in the container env.
2. Migrations run. Empty-DB boot.
3. Customer opens the inspector via port-forward or bastion.
4. Header renders **"No tunnel configured"** with a prominent CTA.
5. Customer clicks **Configure tunnel**, pastes their controller-side Tunnel Security bearer + connector name, submits.
6. Tunnel dials. Header flips to green.

**Zero shell edits.** The `.env` file only ever needed for `POSTGRES_URL` + `CONNECTOR_KEY_FILE` — both of which are typically set via container env / K8s manifest, not `.env`, so a Kubernetes-native customer never touches a file on disk.

## Fault handling

- **Postgres unreachable at boot.** Fail-fast with clear error: `"Postgres unreachable at postgres://user@host:5432/mcp — connector cannot boot without persistence. Check POSTGRES_URL and that the DB is running."`. Empty-state boot is NOT an option here (that would mask a real config error as "just configure via the UI").
- **Master key file missing / wrong mode.** Fail-fast with the actionable error message (name the path, name the expected mode).
- **Master key file present but doesn't match `encryption_meta.key_fingerprint`.** Fail-fast: `"master key fingerprint mismatch. Recover by rotating via 'mcp-connector rotate-master-key' or restoring the original key file."`. This is the "operator swapped keys without running the rotation command" case — mostly a Phase-2-multi-account concern, but the check is cheap enough to include Phase-1.
- **Inspector form submit with malformed values.** Return `400` with the field-level error; the UI surfaces it inline.
- **Inspector form submit dials the tunnel but it 401s.** Return `4xx` with `"tunnel dial rejected: HTTP 401. Check the bearer or that the connector name matches the controller-side Tunnel Security row (case-sensitive)."`. Row is kept if this was an UPDATE (so the operator can retry after fixing), rolled back if it was an INSERT (avoid stranding an unusable row on first-add).
- **Registration-rejected on reconnect** (existing `unknown_registration_token`). Same behavior as today: `registrationRejected` flag set, `store.clearRegistrationToken(id)` called, inspector shows a red badge. Operator clicks **Force re-registration** to mint fresh.

## Concurrency

- **One connector process reads/writes this DB.** No cross-process locking.
- **Multiple inspector clicks in flight.** `upsertController` is a single `INSERT ... ON CONFLICT (id) DO UPDATE` — last write wins; both callers see `200`.
- **Boot ↔ inspector race.** Both paths share the same `ConfigStore` instance in-process. No race.

## Forward compatibility with MULTI-ACCOUNT

Phase-2 upgrade is bit-additive: **drop the `one_controller_only` unique index; iterate `SELECT * FROM controllers WHERE enabled=TRUE` instead of `SELECT ... LIMIT 1`.** Supervisor keying, manifest builder, and dispatcher changes described in [`MULTI-ACCOUNT.md`](MULTI-ACCOUNT.md) are Phase-2 code; nothing in this plan forecloses them.

## Implementation task sequence

Execute these steps in order. Each step has an explicit acceptance criterion. Do not proceed to the next step until the current step's criterion passes.

### Step 1 — Prerequisites `[ONLINE]` ✅ COMPLETE (2026-07-11)

Complete all five sub-steps under §"Prerequisites — DO THIS BEFORE GOING OFFLINE" above (cut branch, npm install, docker pull, generate master.key, verify).

Acceptance:
- `git branch --show-current` prints `feature/env-to-db`. ✅
- `npm ls pg libsodium-wrappers @types/pg @types/libsodium-wrappers --workspace @mcp-shim/connector` prints the four resolved packages. ✅
- `.local/master.key` exists at 32 bytes mode 0600. ✅
- Commit: `cae3ebb chore(env-to-db): add pg + libsodium-wrappers deps`, `3e7b755 chore(env-to-db): gitignore .local directory`. ✅

**Postgres environment note (revised from plan):** we're reusing the existing `mcp-shim-ek-postgres` container (pgvector/pgvector:pg16, host port 5433). Do NOT `docker run` a new one. The `enterprise_knowledge` database, `ek` user, and EK's `public` schema stay untouched; the connector's tables live in the `mcp_connector` schema (or `test_mcp_connector_*` schemas during test runs). Tests use `POSTGRES_URL=postgres://ek:ek-dev-password@localhost:5433/enterprise_knowledge`.

**After this step passes, disconnect. Every remaining step is `[OFFLINE OK]`.**

### Step 2 — Create the `config-store/` module `[OFFLINE OK]` ✅ COMPLETE (2026-07-11)

Commit: `22f57c3 feat(env-to-db): add ConfigStore module + unit tests (Steps 2-3)`.

Files shipped:
- `packages/connector/src/config-store/schema.ts` — exports `schemaSql(schema: string): string` (function, not constant — see Resume Point gotcha #1)
- `packages/connector/src/config-store/master-key.ts` — `resolveMasterKey()` reads `CONNECTOR_KEY_FILE`, checks mode 0600 + 32-byte length, returns `{bytes, fingerprint}`
- `packages/connector/src/config-store/seal.ts` — libsodium `crypto_secretbox_easy` wrapper, uses `createRequire` to work around `libsodium-wrappers@0.7.15` broken ESM entry (see gotcha #2)
- `packages/connector/src/config-store/index.ts` — `ConfigStore` class with `open` / `getController` / `upsertController` / `updateRegistrationToken` / `clearRegistrationToken` / `recordConnect` / `recordDisconnect` / `close`
- `packages/connector/src/boot/creds-source.ts` — `resolveCredsSource(): "env" | "db"` (default `"db"`)

Acceptance: `npm run --workspace @mcp-shim/connector build` succeeds. ✅

### Step 3 — Unit tests for the config-store `[OFFLINE OK]` ✅ COMPLETE (2026-07-11)

Commit: same (`22f57c3` bundled Steps 2+3).

Files shipped under `packages/connector/tests/config-store/`:
- `seal.test.ts` (5 tests) — round-trip; tampered ciphertext throws; wrong key throws; truncated ciphertext throws
- `master-key.test.ts` (7 tests) — missing file throws; wrong mode (0644) throws; wrong length (16 / 64 bytes) throws; correct 32-byte 0600 returns MasterKey with 64-hex fingerprint; different keys → different fingerprints
- `config-store.test.ts` (13 tests, requires live Postgres) — first `open()` populates `encryption_meta`; second open same key succeeds; open with wrong key throws; `upsertController` INSERT then UPDATE preserves row `id`; validates required fields; validates static-bearer requires `tunnelAuthToken`; validates oauth2-cc requires all oauth fields; round-trips oauth2 fields; `getController()` returns null when empty; `getController()` decrypts all `*_ct` columns; `updateRegistrationToken` stores encrypted; `clearRegistrationToken` clears
- `creds-source.test.ts` (9 tests) — unset → `"db"`; empty string → `"db"`; `"env"` → `"env"`; `"db"` → `"db"`; `auto` / `both` / `fallback` / `ENV` / `DB` all throw

Acceptance: `POSTGRES_URL=postgres://ek:ek-dev-password@localhost:5433/enterprise_knowledge npm test --workspace @mcp-shim/connector` → **300 tests pass across 34 files** (34 new + 266 pre-existing, no regressions). ✅

Acceptance: `npm test` passes.

### Step 4 — Rewire `requireEnv` — branch on `credsSource` `[OFFLINE OK]` ✅ COMPLETE (2026-07-11)

Commit: `90d474f feat(env-to-db): branch requireEnv on CONNECTOR_CREDS_SOURCE (Step 4)`.

Files edited:
- `packages/connector/src/boot/require-env.ts` — branch on `resolveCredsSource(env)` at start; legacy `env` branch is verbatim copy; new `db` branch requires `POSTGRES_URL` + `CONNECTOR_KEY_FILE`. Header comment updated to document both modes.
- `packages/connector/src/boot/creds-source.ts` — widened to accept optional `env` map (mirrors `envOptional`), one line change.
- `packages/connector/tests/boot/require-env.test.ts` — added 12 tests: `db mode` (7), `explicit env mode` (2), `default credsSource behavior` (3). `ALL_REQUIRED` fixture now carries `CONNECTOR_CREDS_SOURCE: "env"` so existing tests continue to exercise env-mode.
- `packages/connector/tests/config-store/creds-source.test.ts` — added 1 test for the optional env map argument.

Result: 313 tests pass (300 previous + 13 new).

---

**Historical spec (kept for reference):**

Edit `packages/connector/src/boot/require-env.ts`. The function now branches on `resolveCredsSource()` at its start:

```ts
import { resolveCredsSource } from "./creds-source.js";

export function requireEnv(env: NodeJS.ProcessEnv = process.env): void {
  // Apply CONNECTOR_CONFIG default (unchanged — both modes need the yaml)
  if (!envOptional("CONNECTOR_CONFIG", env)) env.CONNECTOR_CONFIG = "./connector.yaml";

  const credsSource = resolveCredsSource();
  const findings: MissingEnvFinding[] = [];

  if (credsSource === "env") {
    // Legacy path — the old requireEnv logic, verbatim.
    // Requires CONTROLLER_URL, CONNECTOR_NAME, and one auth posture.
    // COPY the old logic here without modification.
  } else {
    // credsSource === "db"
    if (!envOptional("POSTGRES_URL", env)) {
      findings.push({ message: "  POSTGRES_URL is required (e.g. postgres://user:pass@host:5432/mcp). Set in .env or container env." });
    }
    if (!envOptional("CONNECTOR_KEY_FILE", env)) {
      findings.push({ message: "  CONNECTOR_KEY_FILE is required (path to a 32-byte master key file, mode 0600)." });
    }
  }

  if (findings.length === 0) return;
  // ...existing consolidated-error rendering...
}
```

Acceptance: unset `CONNECTOR_CREDS_SOURCE` defaults to `db` and requires `POSTGRES_URL` + `CONNECTOR_KEY_FILE`. Setting `CONNECTOR_CREDS_SOURCE=env` requires the legacy per-controller vars and does NOT require `POSTGRES_URL`.

### Step 5 — Split `resolveAuth` into two exports `[OFFLINE OK]` ✅ COMPLETE (2026-07-11)

Commit: `7eef148 feat(env-to-db): split resolveAuth into env / row exports (Step 5)`.

Files edited:
- `packages/connector/src/boot/auth.ts` — renamed `resolveAuth` → `resolveAuthFromEnv` (verbatim), added new `resolveAuthFromRow(row: ControllerRow)`. Both return the same `AuthResolution` shape.
- `packages/connector/src/boot/lifecycle.ts` — call site updated to `resolveAuthFromEnv`. No other changes.
- `packages/connector/tests/boot/auth.test.ts` — renamed to test `resolveAuthFromEnv`.
- `packages/connector/tests/boot/auth-from-row.test.ts` — new file, 6 tests covering static-bearer + oauth2-cc happy paths and per-field validation errors.

Result: 319 tests pass (313 previous + 6 new).

---

**Historical spec (kept for reference):**

Edit `packages/connector/src/boot/auth.ts` — keep BOTH signatures. The old one stays for `env` mode; add the new one for `db` mode.

```ts
import type { ControllerRow } from "../config-store/index.js";
import { OAuthClientCredentialsProvider } from "../auth/oauth-provider.js";

export interface AuthResolution {
  authToken: string | undefined;
  authProvider: OAuthClientCredentialsProvider | undefined;
  status: string;
}

// LEGACY (env mode). Verbatim from before — do NOT modify. Renamed export.
export function resolveAuthFromEnv(
  configAuthToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthResolution {
  // ...old body verbatim...
}

// NEW (db mode).
export function resolveAuthFromRow(row: ControllerRow): AuthResolution {
  if (row.authMode === "oauth2-cc") {
    if (!row.oauthClientId || !row.oauthClientSecret || !row.oauthTokenUrl) {
      throw new Error("controller row has authMode=oauth2-cc but is missing oauth fields");
    }
    return {
      authToken: undefined,
      authProvider: new OAuthClientCredentialsProvider(row.oauthClientId, row.oauthClientSecret, row.oauthTokenUrl),
      status: `oauth2 (clientId=${row.oauthClientId})`,
    };
  }
  if (!row.tunnelAuthToken) throw new Error("controller row has authMode=static-bearer but is missing tunnelAuthToken");
  return { authToken: row.tunnelAuthToken, authProvider: undefined, status: `set (len=${row.tunnelAuthToken.length})` };
}
```

Rename any existing `resolveAuth` import site to `resolveAuthFromEnv`. New sites (in `bootFromDb`) call `resolveAuthFromRow`.

Acceptance: existing `auth.test.ts` tests pass unchanged (they call `resolveAuthFromEnv`); a new `auth-from-row.test.ts` covers the row-based path.

### Step 6 — Rewire `boot()` in `lifecycle.ts` — dispatch on flag `[OFFLINE OK]` ✅ COMPLETE (2026-07-11)

Commit: `b9d683d feat(env-to-db): split boot() into env / db dispatchers (Step 6)`.

Files edited (one only): `packages/connector/src/boot/lifecycle.ts` (+550 net lines).

Structure now:
- Line 51: `export async function boot()` — 5-line thin dispatcher on `resolveCredsSource()`.
- Line 57: `async function bootFromEnv()` — verbatim extraction of the pre-Step-6 `boot()` body (~715 lines, no logic changes).
- Line 772: `async function bootFromDb()` — new; parallel implementation with row-based auth + DB registration-token persistence.

Notable behaviors in `bootFromDb`:
- Empty-DB path (line 949–953): logs "no controller row; waiting for inspector configuration at http://127.0.0.1:<port>/" and returns without constructing a `TunnelClient`. Inspector + MCPs stay running so the operator can configure via the (Step-9) form.
- Register-ack (line 1091): `store.updateRegistrationToken(row.id, frame.registrationToken)`.
- Register-rejected (line 1099): `store.clearRegistrationToken(row.id)`.
- D11 one-shot cleanup (line 1081–1089): after the FIRST successful register-ack, best-effort `unlinkSync(defaultStatePath())` with tracked `stateCleared` boolean. Any error swallowed.
- Reconnect edge case (line 1216): re-fetches the row from DB on each reconnect and warns if the operator has deleted it — defensive programming beyond the plan spec, kept because it prevents a subtle "connector loops forever on stale in-memory row" failure mode.

Test outcome: 319 tests pass (unchanged from Step 5). No new test file added — mocking `requireEnv` at the module boundary was awkward and the prompt explicitly allowed skipping the optional dispatcher test. The 319 pre-existing tests are the primary regression signal; a broken extraction would have failed them.

**Do NOT edit `lifecycle.ts` from here forward except as a call-site update for Step 9's inspector routes.** The dispatcher / env-flow / db-flow split is settled.

---

**Historical spec (kept for reference):**

Edit `packages/connector/src/boot/lifecycle.ts`. The exported `boot()` becomes a thin dispatcher; the old body moves under a new `bootFromEnv()` function; a new `bootFromDb()` function implements the DB-backed flow.

```ts
export async function boot(): Promise<void> {
  const credsSource = resolveCredsSource();
  if (credsSource === "env") { await bootFromEnv(); return; }
  await bootFromDb();
}

async function bootFromEnv(): Promise<void> {
  // VERBATIM the old boot() body (calls requireEnv, loadConfig, resolveAuthFromEnv,
  // readState, new TunnelClient(...), etc.). Do NOT modify.
}

async function bootFromDb(): Promise<void> {
  requireEnv();  // (already branches internally per Step 4)
  await initSodium();
  const masterKey = resolveMasterKey();
  const store = await ConfigStore.open(masterKey);
  const config = loadConfig(envOptional("CONNECTOR_CONFIG")!);
  // ... start inspector, spawn shared MCPs (same as bootFromEnv up to the tunnel dial) ...
  const row = await store.getController();
  if (!row) {
    // Empty-DB path: inspector is up, shared MCPs are running. Do NOT construct a TunnelClient.
    log.info("no controller row; waiting for inspector configuration at http://127.0.0.1:9090/");
    return;
  }
  const auth = resolveAuthFromRow(row);
  // Construct TunnelClient(row.controllerUrl, auth.authToken, row.connectorName, auth.authProvider)
  // On register-ack success: await store.updateRegistrationToken(row.id, token);
  //   AND try { unlinkSync(defaultStatePath()); } catch { /* swallow ENOENT */ }  // D11
  // On register-rejected: await store.clearRegistrationToken(row.id)
  // Wire the inspector's tunnel-routes handlers to a `dialTunnel(row)` closure defined here.
}
```

Acceptance:
- `CONNECTOR_CREDS_SOURCE` unset AND a `controllers` row exists → boots via `bootFromDb`, dials the tunnel.
- `CONNECTOR_CREDS_SOURCE` unset AND `controllers` table empty → boots via `bootFromDb`, inspector shows "No tunnel configured", no TunnelClient constructed.
- `CONNECTOR_CREDS_SOURCE=env` → boots via `bootFromEnv`, behavior identical to pre-migration release.

### Step 7 — CANCELLED — do NOT delete `state.ts` `[OFFLINE OK]`

Because the flag exists (D1), `state.ts` is still used by `bootFromEnv`. **Do not touch this file.** Step 7 is a no-op; this heading is retained so the step numbering matches the earlier planning discussion.

### Step 8 — Keep the `tunnel:` yaml block `[OFFLINE OK]` ✅ COMPLETE (2026-07-11) — Retrospective fix (2026-07-20)

Commit: `21efcf9 feat(env-to-db): warn on legacy tunnel: yaml block under db mode (Step 8)`.

Files edited: `packages/connector/src/boot/lifecycle.ts` (+5 lines — the WARN in `bootFromDb`), `connector.yaml.example` (+7 lines — comment banner above the `tunnel:` block). `config.ts` NOT modified — the zod schema's `tunnel:` field stays as-is; `env` mode still requires it, `db` mode ignores it.

WARN text: `"legacy 'tunnel:' block in connector.yaml ignored under CONNECTOR_CREDS_SOURCE=db; remove it from your yaml"`. Fires once per boot, immediately after `loadConfig(configPath)` in `bootFromDb`.

Result: 319 tests still pass. No new tests added — pino log-capture would have dragged in boot orchestration for a WARN that's trivially eyeball-verifiable at boot.

---

**2026-07-20 retrospective — Step 8 landed broken; fixed here.** The above "eyeball-verifiable at boot" claim was tested on a dev machine that still had `CONTROLLER_URL` populated in `.env` from the pre-migration state. In the actual db-mode target end state (operator has stripped `CONTROLLER_URL` / `CONNECTOR_NAME` / `TUNNEL_AUTH_TOKEN` from `.env` per the migration doc), boot dies with `Missing env var ${CONTROLLER_URL} at connector.yaml:17` — thrown by `interpolateEnv()` at [`config.ts:238`](../../packages/connector/src/config.ts#L238) BEFORE `loadConfig` returns to `bootFromDb`, so the "ignored — remove it" WARN never fires. The plan's line 1159 assumption that "its presence in an inherited yaml is harmless" only held under populated env vars. Fix commit: (follow-up on `feature/agentic-memory-mock`).

Root cause: `interpolateEnv` is a whole-document text pass — it has no notion of "which yaml block does this ${VAR} belong to", so a `${CONTROLLER_URL}` inside the tunnel: block (or in a doc comment mentioning it) throws even though downstream code would have ignored the parsed value.

Files touched by the retrospective fix:
- `packages/connector/src/config.ts` — made `tunnel:` OPTIONAL at the top level (finishing the "optional-with-WARN" contract line 381 called for), added zod `preprocess(null → "")` on `controller_url` / `name` so YAML's bare `key: ` (empty interpolation) parses cleanly, relaxed `controller_url` to `z.string().url().or(z.literal(""))`.
- `packages/connector/src/boot/lifecycle.ts` — added a defensive guard at the top of `bootFromEnv` that throws with an operator-actionable error when `config.tunnel` is missing / empty; hoisted a `tunnelConfig` const so async closures capture the narrowed type. `bootFromDb`'s existing WARN is now reachable.
- `packages/connector/src/manifest/build.ts` — one `config.tunnel?.environment ?? "dev"` for the newly-optional block.
- `connector.yaml.example` — `${CONTROLLER_URL}` → `${CONTROLLER_URL:-}` (and same for `CONNECTOR_NAME`) so interpolation succeeds with empty when the legacy env vars are stripped. Also fixed a bare `${MCP_DROPIN_DIR}` and `${CONTROLLER_URL}` inside DOC COMMENTS — since `interpolateEnv` doesn't strip yaml comments, these were also throwing. Changed to `$VAR` bare form (doesn't match the `${...}` interpolator regex).
- `packages/connector/tests/config/interpolate-env.test.ts` — added 4 regression tests under `describe("loadConfig — Step 8 regression: db-mode migration end state")`:
  1. legacy tunnel: block with `${VAR:-}` defaults + unset env vars parses cleanly (empty strings).
  2. yaml with tunnel: block entirely removed parses cleanly (`config.tunnel === undefined`).
  3. populated tunnel: block still parses with real values (env-mode happy path unchanged).
  4. **SHIPPED `connector.yaml.example` loads cleanly with no tunnel env vars set** — pins the actual file customers copy, uses `vi.stubEnv(x, undefined)` to simulate a truly-unset env (which the original `vi.stubEnv(x, "")` did NOT catch; the distinction between present-but-empty and truly-absent surfaced a real regression during test development).

Result: 404 tests pass (up from 319). The retrospective test #4 above would have caught the original Step 8 bug directly — it exercises the specific failure mode ("shipped yaml.example + empty env → interpolator throws") that Step 8's eyeball-verification missed.

Verified end-to-end: `./scripts/start-connector.sh` under db mode with `.env` containing only `POSTGRES_URL` + `CONNECTOR_KEY_FILE` (no legacy per-controller vars) boots cleanly, tunnel dials via DB row, register-ack succeeds.

The developer's `./connector.yaml` was also updated: `tunnel:` block removed entirely (now that the schema allows absence, and db mode ignores it anyway). The .example still ships the block because env mode is still a supported (deprecated) posture — see the D1 flag and Step 14 removal timeline.

**Lesson for Step 14:** when a migration says "you don't need X anymore," the test that ships alongside must exercise the "X is truly absent" scenario, not "X is empty-but-present." The `vi.stubEnv(key, "")` vs `vi.stubEnv(key, undefined)` distinction is the difference between validating the caretaker path and validating the target end state.

---

**Historical spec (kept for reference):**

Edit `packages/connector/src/config.ts`:
- The `tunnel:` object in the zod schema stays. In `env` mode it's required (existing behavior). In `db` mode `bootFromDb` never reads the block, so its presence in an inherited yaml is harmless — but log a WARN in `bootFromDb` if `config.tunnel` is present: `"legacy 'tunnel:' block in connector.yaml ignored under CONNECTOR_CREDS_SOURCE=db; remove it from your yaml"`.

Edit `connector.yaml.example`: the `tunnel:` block stays for `env` mode; add a comment banner above it explaining `db` mode does not read it.

Acceptance: `bootFromEnv` reads the yaml `tunnel:` block as before. `bootFromDb` logs the WARN and continues.

### Step 9 — Inspector routes + UI `[OFFLINE OK]` ✅ COMPLETE (2026-07-11) — SPLIT INTO 9a + 9b

**Split note:** Originally one step in the plan; split into 9a (backend routes + wiring, testable via curl and unit tests) and 9b (browser UI, verified via Playwright) for verification granularity. Also: **decision D4 supersedes this section's mention of a `POST /internal/tunnel/remove` route** — Phase-1 ships Add + Edit + Force-reregister only.

**Step 9a commits:** `94dc0e3` (initial routes + wiring), `233d33f` (follow-up fixing missing dial-on-upsert + INSERT rollback). Files: `packages/connector/src/inspector/tunnel-routes.ts` (new), `inspector/server.ts` (`wireTunnelRoutes` method), `boot/lifecycle.ts` (`dialTunnel` / `cycleTunnel` closures extracted and threaded through `wireTunnelRoutes`), `config-store/index.ts` (`deleteController()` for INSERT rollback). Tests: `packages/connector/tests/inspector/tunnel-routes.test.ts` (15 tests) + `config-store/config-store.test.ts` (+2 deleteController tests).

**Step 9b commit:** `bbd52c4`. Files: `packages/connector/public/{index.html, app.js, style.css}` — Tunnel panel + modal form. No new unit tests (frontend has no test infrastructure in this repo); verified via Playwright against a mock backend covering four scenarios (empty, static-configured, oauth-configured, env-mode 404, dial-fail rollback).

Result: 339 tests pass (+17 net vs pre-Step-9).

---

**Historical spec (kept for reference):**

Add `packages/connector/src/inspector/tunnel-routes.ts` per §"New modules". Mount its four handlers in `inspector/server.ts`. **These routes are only wired when `bootFromDb` is the active path** — `bootFromEnv` does NOT mount them (there's no `ConfigStore` in that mode). Concretely: `bootFromDb` calls a new `inspector.wireTunnelRoutes({ configStore, dialTunnel, cycleTunnel })` after constructing the inspector; `bootFromEnv` does not.

Add to `public/app.js` + `public/index.html` + `public/style.css`:
- "Tunnel" panel with empty-state CTA OR configured-state readout.
- "Configure tunnel" / "Edit tunnel" modal with the form fields listed in §"Inspector as the write path".
- "Force re-registration" button.

The UI's "Tunnel" panel discovers whether it's in `db` or `env` mode via `GET /internal/tunnel/config`: if the route returns 404, the connector is in `env` mode and the panel renders "Tunnel identity is configured via `.env` (CONNECTOR_CREDS_SOURCE=env)" instead of the form.

Acceptance:
- Under `db` mode with empty DB: `curl -X POST http://127.0.0.1:9090/internal/tunnel/creds -d '{...valid JSON...}'` responds `200 {ok:true}`; subsequent `GET /internal/tunnel/config` returns `configured: true` with no secret values; tunnel dials; register-ack succeeds.
- Under `db` mode with row present: submitting Edit with a new bearer causes `goodbye` + redial; register-ack succeeds.
- Under `env` mode: `GET /internal/tunnel/config` returns 404 and the UI shows the legacy-mode banner.
- `GET /internal/tunnel/config` never contains the strings `tunnelAuthToken`, `oauthClientSecret`, or `registrationToken` as top-level keys, and no `_ct` bytes appear in the body.

### Step 10 — Update `.env.example` — BOTH modes `[OFFLINE OK]`

Edit `.env.example` at the repo root. The file now documents both modes with clear section banners:

```
# ═══════════════════════════════════════════════════════════════════════════
# CONNECTOR_CREDS_SOURCE — pick which mode this connector runs in.
# Default: "db" (unset or empty falls back to "db")
# Values:
#   "db"   — tunnel identity + creds live in Postgres; managed via inspector UI
#   "env"  — legacy: tunnel identity + creds live in this .env file (this file
#            + connector.yaml + .connector-state.json). Being removed one
#            release after the "db" path is proven; new deployments should
#            NOT choose this.
# ═══════════════════════════════════════════════════════════════════════════
CONNECTOR_CREDS_SOURCE=db

# ─── Vars required when CONNECTOR_CREDS_SOURCE=db (default) ──────────────
POSTGRES_URL=postgres://user:pass@host:5432/mcp
POSTGRES_SCHEMA=mcp_connector
CONNECTOR_KEY_FILE=/run/secrets/mcp-connector/master.key

# ─── Vars required when CONNECTOR_CREDS_SOURCE=env (legacy) ──────────────
# CONTROLLER_URL=https://your-controller.example.com
# CONNECTOR_NAME=my-customer
# TUNNEL_AUTH_TOKEN=
# # OAuth2 posture (alternative to TUNNEL_AUTH_TOKEN):
# # OAUTH_CLIENT_ID=
# # OAUTH_CLIENT_SECRET=
# # OAUTH_TOKEN_URL=
```

Also: after `requireEnv()` in `bootFromDb`, log a WARN for any legacy per-controller env var still present in `process.env`: `"legacy per-controller env var '<name>' present but ignored (CONNECTOR_CREDS_SOURCE=db); remove from .env"`. Do NOT log the WARN under `bootFromEnv` (there they're required).

Acceptance: a `.env` with only the new keys boots clean in `db` mode; a `.env` with only the legacy keys + `CONNECTOR_CREDS_SOURCE=env` boots clean in `env` mode; mixed `.env` (both sets present + `CONNECTOR_CREDS_SOURCE=db`) boots clean with WARN.

### Step 11 — Leak-channel + logger redact backstops `[OFFLINE OK]`

Extend `packages/connector/tests/inspector/session-creds-leak.test.ts` (or add `tunnel-creds-leak.test.ts` alongside) to assert:
- No inspector route response body contains the decrypted `tunnelAuthToken` / `oauthClientSecret` / `registrationToken` values (call `upsertController` with unique sentinel strings; grep every response body from every route).
- No SSE event kind contains those sentinels.

Extend `packages/connector/tests/logger/redact.test.ts` to add these field paths to the pino `redact.paths` allowlist and assert they redact in logged objects.

Acceptance: `npm test` passes.

### Step 12 — Docs update `[OFFLINE OK]`

Update:
- `CLAUDE.md` §"Config files" — describe both modes. `db` is the default and recommended; `env` is documented as legacy and marked for removal.
- `packages/connector/README.md` — first-run instructions say "the default is `db` mode; open the inspector to configure. If you're on the legacy `env` mode, edit `.env`."

Acceptance: no doc claims `.env` is the ONLY authoritative source; no doc omits the `env` mode entirely.

### Step 13 — Final commit + merge to `main` `[OFFLINE OK]`

You have finished Steps 2–12. All file changes should be on `feature/env-to-db`. Do the final commit + merge here.

```bash
# Sanity: confirm you're still on the feature branch
git branch --show-current                    # must print feature/env-to-db

# Review what's about to merge
git status                                    # should show any uncommitted files
git diff main..HEAD --stat                    # summarize per-file line counts

# Stage everything and commit. Use a single squash-worthy commit OR keep
# incremental commits from Steps 2–12 — implementer's choice, but do NOT
# use `--no-verify` or `--amend` on a shared commit.
git add -A
git commit -m "$(cat <<'EOF'
feat(env-to-db): migrate tunnel creds from .env to Postgres row

Adds ConfigStore module with libsodium-sealed columns, master-key file
sourcing, and inspector UI form for pasting tunnel creds. Gated behind
CONNECTOR_CREDS_SOURCE (default "db"; "env" preserves the legacy path
for one release cycle). See .claude/plans/ENV-TO-DB.md.
EOF
)"

# Merge to main with an integration commit preserved (--no-ff).
git checkout main
git merge --no-ff feature/env-to-db -m "Merge feature/env-to-db: tunnel creds in Postgres"
```

Rules (do NOT deviate):
- **Use `--no-ff`.** The integration commit must survive in `main`'s history.
- **Do NOT `git push` the feature branch to origin.** Only `main` belongs on origin. (Whether the human operator pushes `main` after this is out of scope for this plan.)
- **Do NOT delete the feature branch** (no `git branch -d feature/env-to-db`). Leave the ref in place.
- **Do NOT use `--no-verify` on any commit.** If a pre-commit hook fails, fix the underlying issue and create a NEW commit; never bypass.
- **Do NOT amend a commit that has already been included in the merge.** Amending rewrites history and breaks the integration record.

After the merge succeeds, mark the plan complete:

Edit the very top of `.claude/plans/ENV-TO-DB.md` (line 3) — change:
```
> **Status:** planning only, **2026-07-10**. No branch yet. Coding intentionally deferred — this is a shape doc.
```
to:
```
> **Status:** completed **YYYY-MM-DD** on branch `feature/env-to-db` (merged to `main`).
```
(Use today's date.) Commit that plan update directly to `main`:

```bash
git add .claude/plans/ENV-TO-DB.md
git commit -m "docs(env-to-db): mark plan completed"
```

Acceptance:
- `git log main --oneline | head -5` shows the `Merge feature/env-to-db: ...` commit.
- `git branch | grep env-to-db` still lists the feature branch (not deleted).
- `head -3 .claude/plans/ENV-TO-DB.md` shows the "completed YYYY-MM-DD" status line.

### Step 14 — Remove the feature flag (follow-up PR, NOT part of the initial migration) `[OFFLINE OK]`

Ship this ONE release after Step 13's merge lands and the `db` mode is proven in production. **Do not perform Step 14 as part of the same PR as Steps 1–12.** Cut a fresh feature branch (`feature/env-to-db-flag-removal`) off `main` for this work; same local-only + `--no-ff` + keep-branch conventions as Step 13.

- Delete `packages/connector/src/boot/creds-source.ts`.
- In `boot/lifecycle.ts`: delete `bootFromEnv`, rename `bootFromDb` → `boot`, delete the dispatcher.
- Delete `packages/connector/src/state.ts` and every import.
- Delete `resolveAuthFromEnv` from `boot/auth.ts`. Rename `resolveAuthFromRow` → `resolveAuth`.
- Delete the `tunnel:` block from `packages/connector/src/config.ts`'s zod schema. Delete the WARN branch in `bootFromDb`.
- Delete the `tunnel:` block from `connector.yaml.example`.
- Delete the legacy section (and `CONNECTOR_CREDS_SOURCE=db` line — it's the only mode now) from `.env.example`.
- Delete the legacy-key WARN loop.
- Delete `auth.test.ts` tests that exercise the env-based `resolveAuth`.
- Update `CLAUDE.md` and `README.md` — remove all references to `CONNECTOR_CREDS_SOURCE` and legacy `env` mode.

Acceptance: `npm test` + `tsc -b` pass; no repo file mentions `CONNECTOR_CREDS_SOURCE` or `bootFromEnv`.


