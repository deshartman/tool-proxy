# Test Suite — Living Plan

> **How we use this doc.** The connector is verified by **manual scenarios through the inspector UI**. When a manual run surfaces a bug or surprising behavior, the loop is:
>
> 1. **Log it** — append a row to the [Test catalog](#test-catalog--defensive-tests-as-they-land) below (date, scenario, source file, test file path, invariant, status `failing`).
> 2. **Reproduce it in vitest** — write a failing test at `packages/connector/tests/<area>/<unit>.test.ts` that pins the bug.
> 3. **Fix it in `src/`** — minimal change to make the test pass.
> 4. **Flip the row** — status `failing` → `passing`. The test stays as the regression guard.
>
> The suite is **regression-driven, not coverage-driven** — tests exist because something went wrong once. New tests come from real findings, not a coverage target. If you're reading this fresh, the next action is almost always "the user has a manual finding to log" — ask which scenario.
>
> **For architectural context**, read the [Connector lifecycle map](#connector-lifecycle-map) below before deciding what to test next. It maps each phase of the boot sequence to its testability (pure / fakes-required / integration-only) and tracks which surfaces are open, deferred, or already covered. Active in-flight test plans (e.g. [TESTING.md](TESTING.md) on `feature/testing`) reference that map rather than re-deriving it.
>
> **Inventory of landed tests** lives in [TESTS_IMPLEMENTED.md](TESTS_IMPLEMENTED.md) — one row per test as it ships. This file tracks *proposals* and *invariants*; `TESTS_IMPLEMENTED.md` tracks *what's running*. When a defensive test lands, add a row there and flip the catalog row here from `failing` → `passing`.

## Env-var testing — preferred approach

Many surfaces dispatch on env vars (`TUNNEL_AUTH_TOKEN`, `OAUTH_CLIENT_*`, `CONTROLLER_URL`, `CONNECTOR_NAME`, `CONNECTOR_STATE_PATH`, `MCP_BASE_PORT`, `INSPECTOR_PORT`, `LOG_LEVEL`, `NODE_ENV`, plus per-MCP `BUNDLE_DEV_OVERRIDE_*`). Tests that depend on these MUST use **`vi.stubEnv(name, value)`** rather than reading from a `.env` file.

Why:
- `.env` files leak across tests via `process.env` mutation. Vitest doesn't roll them back between cases.
- `vi.stubEnv()` is auto-restored by `vi.unstubAllEnvs()` in `afterEach` (or globally via `unstubEnvs: true` in `vitest.config.ts`).
- The connector's `dotenv/config` import runs **once at process start**. Tests that try to mutate `.env` after that import are racing the loader.
- `vi.stubEnv` makes the env preconditions visible at the top of the test, which is the documentation we want — "this is the env state under test", not "go read `.env.example` and infer".

Patterns:

```ts
// Reset between cases — put in test file or tests/helpers/setup.ts
import { afterEach, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());

// Static-bearer posture
vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_row1_abc");
vi.stubEnv("CONNECTOR_NAME", "test-customer");
vi.stubEnv("OAUTH_CLIENT_ID", "");  // explicit unset — empty string falsy in resolveAuth

// OAuth2 posture
vi.stubEnv("OAUTH_CLIENT_ID", "client_test");
vi.stubEnv("OAUTH_CLIENT_SECRET", "secret_test");
vi.stubEnv("OAUTH_TOKEN_URL", "https://oauth.example.com/token");
```

For pure functions that already accept an env map (e.g. `resolveAuth(configToken, env)`), prefer passing a literal `{TUNNEL_AUTH_TOKEN: "..."} as NodeJS.ProcessEnv` over `vi.stubEnv` — it's clearer and doesn't touch global state. Use `vi.stubEnv` only when the surface under test reads `process.env` directly with no injection seam.

**Never `import` a `.env` file in a test**, never call `dotenv.config()` from a test, and never set `process.env.X = "..."` directly. All three break test isolation.

## Context

`CODE_HYGINE.md` Step 4 wired the vitest skeleton (vitest 4 in root devDeps, root `vitest.config.ts`, `npm test` from `packages/connector` exits 0 with "No test files found"). The connector has had no tests historically — verification has been interactive via the inspector UI.

The user's plan: **manually test scenarios, and when an issue is found, write a defensive test that reproduces it, then fix.** This is regression-driven, not coverage-driven. The suite grows organically from real bugs.

This plan does two things:

1. **Make the project genuinely vitest-ready** — finish the few small bits Step 4 deferred so the first defensive test can be written without yak-shaving.
2. **Be a living tracker** — one row per defensive test added (date, scenario observed, file under test, root cause, status) so future Claude can see what's already covered and what manual-test findings remain open.

## Test layout decision — peer `tests/` directory

Tests live at **`packages/connector/tests/**/*.test.ts`** mirroring `packages/connector/src/`. Not colocated.

Why peer-tests over colocation for *this* repo:

- `packages/connector/tsconfig.json` has `rootDir: "src"` + `include: ["src/**/*"]`. Colocated `*.test.ts` would either (a) compile into `dist/` on every `npm run build` (footgun — ships test files in the OCI image, and the postbuild script doesn't strip them), or (b) require a `tsc` exclude rule that vitest's tsx-based loader doesn't actually need.
- A peer `tests/` directory lives outside `rootDir` and never enters the connector's build at all. Vitest compiles tests on the fly via tsx; `tsc -b` ignores them entirely.
- Mirrors what `express`, `koa`, and other Node-side libs do. Modern frontend libs prefer colocation; that constraint (Vite-served sources) doesn't apply to a Node CLI/daemon.
- **Precedent inside Twilio.** `twilio-agent-connect-typescript` (Sierra team) is a single-package repo using peer `tests/` at root with 25 test files + a `tests/helpers/` subfolder for shared fixtures. They use `tsup` for build (which auto-skips tests) and `tsconfig.json` `exclude: ["**/*.test.ts", "**/*.spec.ts"]` belt-and-braces for `tsc --noEmit`. Confirms peer-tests is a live convention on the Twilio dev side.

The root `vitest.config.ts` `include` glob updates from `packages/connector/src/**/*.test.ts` → `packages/connector/tests/**/*.test.ts` as part of the prep step below.

## Prep — what's needed to call the project "vitest ready"

These are small. Verifiable end-to-end in one session.

### P1. Update vitest include glob to peer-tests path

[vitest.config.ts](../../vitest.config.ts) — change `include: ["packages/connector/src/**/*.test.ts"]` to `include: ["packages/connector/tests/**/*.test.ts"]`. Update the comment block to reflect peer-tests over colocation and remove the "tests should sit at packages/connector/src/**/*.test.ts" line which is now wrong.

### P2. Create `packages/connector/tests/` with a sentinel test

`packages/connector/tests/sentinel.test.ts` — five lines, asserts `1 + 1 === 2` (or similar trivial). Proof that:
- vitest discovers files under the new include glob,
- `import { describe, it, expect } from "vitest"` resolves cleanly,
- `npm test` from `packages/connector` reports `1 passed` instead of `No test files found`.

Removed (or rewritten) once the first defensive test lands. Until then it's the wiring smoke check.

### P3. Convention notes (no work, just document)

- **Explicit imports**, not `globals: true`. Existing comment in `vitest.config.ts` already documents this — keep it. Twilio's repo uses globals; we don't.
- **`packages/connector/tests/helpers/`** is the known landing pad for shared fixtures (factories, fake timers, fake Logger). Don't create upfront — add when the second test needs the same helper. Twilio's `tests/helpers/` is the precedent.
- `tests/` is checked in. Nothing under it is generated; no gitignore changes needed.

### P4. Coverage — **defer**

`@vitest/coverage-v8` and a `test:coverage` script land when there are enough tests for the number to mean something. Adding it now produces a 0%-everywhere report. Twilio's repo adds it pre-emptively — both are reasonable; we lean defer for this repo. Tracked here so it doesn't drift out of mind.

### P5. CI hook — **defer**

There's no CI in this repo today (everything is `./scripts/start-connector.sh` + manual). When CI lands, `npm test` from `packages/connector` is the gate. Tracked here, not done now.

## Verification of prep

Run from repo root:

```bash
npm install                                # confirm vitest 4 is resolved
npm run build                              # tsc -b clean — no test files leaked into dist/
cd packages/connector && npm test          # reports "1 passed" against the sentinel
ls packages/connector/dist/sentinel.test.js 2>/dev/null && echo "LEAKED"  # should be absent
npx madge --circular --extensions ts packages/connector/src   # zero cycles preserved
./scripts/start-connector.sh               # one boot round-trip; nothing in prep should affect runtime
```

## Connector lifecycle map

The connector boot sequence has nine phases. This map exists so a
fresh-context Claude can decide *which* surfaces are worth testing without
re-deriving the architecture from source — and why some surfaces are
deliberately deferred. Pure functions are cheap to test (no fakes, no
processes, no ports); integration surfaces need real subprocesses or
WebSockets and are deferred until a manual finding makes them worth the
investment.

### Boot fingerprint (the baseline tests are calibrated against)

A clean `./scripts/start-connector.sh` run on 2026-06-18 produced (saved at
`/tmp/connector-boot.log` during analysis):

- inspector listening at <http://127.0.0.1:9090/> (HTTP 200)
- 5 MCP servers connected: `sample` (port 7100), `crm` (7101), `apis` (7102),
  `aviation-weather` (stdio), `enterprise_knowledge` (Type 3 dev-override)
- 44 tools in the built manifest
- tunnel dialed `https://tap-des.ngrok.dev`
- **first register frame rejected** with `unknown_registration_token` (stale
  token from a prior controller DB) → connector cleared `.connector-state.json`
  → auto-reconnect at 1.5s → second register succeeded with a fresh token →
  `register-ack ok — persisted registrationToken`
- queued `webhook-allocate` for `apis` drained on tunnel-open; webhook URL
  minted as `https://tap-des.ngrok.dev/api/webhook/conn_99218d38/cw_…`

If you're starting fresh: run the connector once, confirm the same shape,
then proceed.

### Phases and testability

```
                                                              testability
┌───────────────────────────────────────────────────────────┐
│ PHASE 0 — Process boot                                     │   shell only
│ scripts/start-connector.sh                                 │   manual
│   ├ pre-cleanup pgrep pattern (CLAUDE.md notes)            │
│   ├ source packages/connector/.env                         │
│   ├ auto-export BUNDLE_DEV_OVERRIDE_*                      │
│   └ exec node packages/connector/dist/index.js start       │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 1 — Config load                                      │   ⭐ PURE
│ src/config.ts loadConfig(yamlPath)                         │
│   ├ readFileSync → ${VAR} interpolation (line-numbered)    │
│   ├ yaml.parse                                             │
│   ├ pre-process bundled: entries (Type 3 → synthetic stdio)│
│   ├ resolveBundledEntry(): override env / registry / errors│
│   ├ Zod discriminated union parse                          │
│   ├ resolve dir: against yaml dir                          │
│   └ load <dir>/.env into per-spec env map (NOT process.env)│   ⭐ "highest-risk piece"
│ src/config.ts isType1Spawn / isType3Bundled / authorOf     │   pure helpers
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 2 — Auth resolution                                  │   ⭐ PURE
│ src/boot/auth.ts resolveAuth(configToken, env)             │
│   ├ OAUTH_CLIENT_ID set    → OAuth2 posture (3 env req'd)  │
│   ├ TUNNEL_AUTH_TOKEN set  → static-bearer posture         │
│   └ neither                → THROW (boot-fail-fast)        │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 3 — State load                                       │   pure (real fs ok)
│ src/state.ts readState(path)                               │
│   ├ no file → {} (first connect)                           │
│   ├ valid JSON → parsed                                    │
│   └ corrupt → throw (caller decides)                       │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 4 — Spawn Type 1 children + connect to all servers   │   real subprocesses
│ src/spawner.ts (probe-bind ports, child supervisor)        │   needs MCP fakes
│ src/servers/connect.ts (HTTP / stdio dispatch)             │   defer
│ src/servers/index.ts toDescriptor(tool, true) ⭐           │   ⭐ PURE — borderline
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 5 — Build manifest                                   │   semi-pure
│ src/manifest/build.ts buildManifest()                      │   needs fake conn
│   ├ async listTools per server                             │
│   ├ authorOf() per spec  ⭐                                │   ⭐ PURE
│   └ stable yaml-order sort                                 │
│ src/manifest/diff.ts diffManifest / isEmptyDelta           │   ⭐ PURE
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 6 — Tunnel dial + register frame                     │   integration
│ src/tunnel/client.ts TunnelClient                          │   ws fake needed
│   ├ build headers: Bearer + X-Connector-Name               │
│   ├ https→wss URL upgrade + /mcp-tunnel path append        │
│   └ either authToken OR await authProvider.accessToken()   │
│ src/auth/oauth-provider.ts accessToken()                   │   ⭐ semi-pure
│   ├ cache check (>60s headroom)                            │   (fetch mockable)
│   ├ POST grant_type=client_credentials                     │
│   ├ expires_in floor (≥60)                                 │
│   └ never logs secret/jwt                                  │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 7 — Register-ack handling                            │   ⭐ PURE
│ src/tunnel/frame-router.ts createFrameRouter(opts)         │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 8 — Steady state                                     │   timer-based
│ heartbeat scheduler (every policy.heartbeat_interval_ms)   │   integration
│ inbound rpc dispatch (controller → MCP)                    │
│ outbound webhook frames (MCP → controller)                 │
│ manifest-delta sender (rediscovery loop)                   │
│ inspector SSE                                              │
│ src/policy/redact.ts                                       │   ⭐ PURE
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 9 — Fault & recovery                                 │   ⭐ PURE
│ src/tunnel/reconnect.ts ReconnectController                │   w/ injected RNG
│   ├ schedule() / cancel() / markAccepted/Rejected          │
│   └ decorrelated jitter backoff                            │
│ src/state.ts clearRegistrationToken                        │   ⭐ PURE
└───────────────────────────────────────────────────────────┘
```

### Phase → test status (read this before deciding what to test)

| Phase | Surface | Status |
|-------|---------|--------|
| 0 | `start-connector.sh` shell | manual only |
| 1 | `config.ts` `loadConfig` (per-entry env isolation, ${VAR} interpolation, policy thunk-parse) | open — planned in [TESTING.md T2](TESTING.md) |
| 2 | `boot/auth.ts` `resolveAuth` (3 branches + fail-fast) | open — planned in [TESTING.md T1](TESTING.md) |
| 3 | `state.ts` read/write/clear | exercised via Step 8 frame-router tests |
| 4 | spawner + servers/connect | deferred (needs real children) |
| 4 | `servers/index.ts toDescriptor` (one-liner) | borderline — skipped |
| 5 | `manifest/build.ts buildManifest` (orchestration) | deferred |
| 5 | `manifest/diff.ts` (structural-vs-cosmetic diff) | deferred (no manual finding yet) |
| 6 | `tunnel/client.ts` TunnelClient | deferred (needs ws fake) |
| 6 | `auth/oauth-provider.ts` `accessToken` (cache + floor + leak) | open — planned in [TESTING.md T3](TESTING.md) |
| 7 | `tunnel/frame-router.ts` | ✅ Step 8 — 8 tests, all passing |
| 7 | `tunnel/mcp-config-coordinator.ts` (v1.1 controller-driven roster — snapshot reconcile, delta CRUD, mcpId-keyed remove, yaml-vs-roster name collisions, generation gap → resync, snapshot-wait timer, reconnect-survival via `bind()`) | ✅ 2026-06-21 — 20 tests + 1 W-E5 transport-stamp test, all passing |
| 7 | `auth/resolve-mcp-auth.ts` (W-E3 sync resolver — none / bearer / header; empty-string treated as missing) | ✅ 2026-06-21 — 11 tests, all passing |
| 7 | `auth/resolve-mcp-auth-async.ts` (W-E4 OAuth2 client_credentials — cache key, rotation invalidation, mint-failure eviction, no-secret-leak) | ✅ 2026-06-21 — 10 tests, all passing |
| 4 | `servers/connect.ts` dispatch (W-E5 — `__transportKind` routes to streamable-http / sse / websocket / stdio; `spec.headers` flows through requestInit) | ✅ 2026-06-21 — 6 tests, all passing |
| 4 | `mcp-supervisor.ts` `register` / `registerOne` source+mcpId plumbing (W-E6) | ✅ 2026-06-21 — 5 tests, all passing |
| 8 | heartbeat / dispatcher / SSE | deferred (integration only) |
| 8 | `policy/redact.ts` (trivial 3-arm switch) | deferred (low drift risk) |
| 9 | `tunnel/reconnect.ts` ReconnectController (jitter + idempotency) | open — planned in [TESTING.md T4](TESTING.md) |

### Env-var surface — coverage map

Every place `src/` reads `process.env` directly. Each row is a surface that benefits from an env-driven test using `vi.stubEnv`. Mark `landed` once a test in `TESTS_IMPLEMENTED.md` covers all branches.

| Var(s) read | Source | Branches to pin | Status |
|---|---|---|---|
| `CONNECTOR_CONFIG`, `CONTROLLER_URL`, `CONNECTOR_NAME`, auth posture | [boot/require-env.ts](../../packages/connector/src/boot/require-env.ts) `requireEnv` | (1) all present → returns clean (both postures), (2) each user-configurable var missing → consolidated error names it, (3) auth posture missing → reports both options, (4) OAuth2 partial → posture-aware error, (5) multiple missing → all listed in one error, (6) empty-string == missing, (7) `CONNECTOR_CONFIG` defaults to `./connector.yaml` in CWD when unset/empty (customer runs `npx mcp-connector start` from their project dir), (8) explicit `CONNECTOR_CONFIG` value is preserved | landed — `tests/boot/require-env.test.ts` (14 cases including CONNECTOR_CONFIG default) |
| `TUNNEL_AUTH_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL` | [boot/auth.ts](../../packages/connector/src/boot/auth.ts) `resolveAuth` | Pure-function contract: happy paths (OAuth2 / static-bearer), posture priority, no-secret-leak in status string, default-arg branch. **User-facing missing-key scenarios moved to `requireEnv()` above.** | landed — `tests/boot/auth.test.ts` (5 cases) |
| `${VAR}` / `${VAR:-default}` in YAML | [config.ts](../../packages/connector/src/config.ts) `interpolateEnv` | (1) defined var substitutes, (2) undefined var with default falls back, (3) undefined no-default throws with line number, (4) per-entry `dir/.env` does NOT mutate `process.env` (isolation invariant from CLAUDE.md), (5) inline yaml `env:` overrides `dir/.env` keys | landed — `tests/config/interpolate-env.test.ts` (13 cases incl. bundle dev-override) |
| `CONNECTOR_STATE_PATH` | [state.ts:22](../../packages/connector/src/state.ts#L22) | (1) unset → defaults to `./.connector-state.json` (CWD-relative — sits next to the customer's `.env` and `connector.yaml`, not inside `node_modules/`), (2) set → resolves relative path against cwd, (3) set absolute → used as-is, (4) empty-string treated as unset (falls back to default) | landed — `tests/state/state-env.test.ts` (11 cases) |
| `MCP_BASE_PORT` | [spawner.ts:38](../../packages/connector/src/spawner.ts#L38) | (1) unset → 7100, (2) set numeric → used, (3) set non-numeric → `Number()` returns NaN (current bug? assert behavior to pin), (4) `opts.basePort` arg wins | open |
| `INSPECTOR_PORT` | [boot/lifecycle.ts:46-48](../../packages/connector/src/boot/lifecycle.ts#L46-L48), [sdk/webhook.ts:81](../../packages/connector/src/sdk/webhook.ts#L81) | (1) unset → 9090, (2) `"0"` → inspector disabled (special-cased), (3) set numeric → used, (4) `--no-inspector` CLI flag overrides to `"0"` (CLI dispatch in [index.ts:67](../../packages/connector/src/index.ts#L67)) | open |
| `CONNECTOR_CONFIG` | [boot/lifecycle.ts:38](../../packages/connector/src/boot/lifecycle.ts#L38), [discover.ts:25](../../packages/connector/src/discover.ts#L25), [index.ts:66](../../packages/connector/src/index.ts#L66) | (1) `--config` CLI arg overrides env, (2) env-only path resolved, (3) neither → `requireEnv` fills the `./connector.yaml` default before load (see landed row above) | (1)(2) still open; (3) covered by require-env tests |
| `CONNECTOR_VERSION` | [index.ts:35](../../packages/connector/src/index.ts#L35), [boot/lifecycle.ts:44](../../packages/connector/src/boot/lifecycle.ts#L44) | (1) unset → `"dev"`, (2) set → echoed verbatim by `version` subcommand and lifecycle | open |
| `LOG_LEVEL`, `NODE_ENV` | [logger.ts:22,29](../../packages/connector/src/logger.ts#L22-L29) | (1) `NODE_ENV=production` → no pretty-print, (2) unset NODE_ENV + non-TTY → no pretty-print, (3) `LOG_LEVEL=debug` lifts level, (4) `LOG_LEVEL` unset → `"info"` | open |
| `PORT` | [sdk/http-server.ts:26](../../packages/connector/src/sdk/http-server.ts#L26) | (1) `opts.port` arg wins, (2) env set numeric → used, (3) unset → 0 (kernel-assign) | open |
| `BUNDLE_DEV_OVERRIDE_<NAME>` | [config.ts](../../packages/connector/src/config.ts) `resolveBundledEntry` | (1) override absent → resolve via `BUNDLED_MCPS` registry, (2) override set → launch redirected to that path, (3) override + missing registry entry → registry takes priority or override wins (pin the actual rule) | open |
| `process.env` snapshot at child spawn | [spawner.ts](../../packages/connector/src/spawner.ts), Type 2 stdio dispatch | per-spec env merged on top of `process.env` per-child; isolation invariant — child A's `API_TOKEN` from `mcp/external/A/.env` does NOT reach child B even when both `.env` files declare the same key | open |

The high-leverage ones are `resolveAuth` (5 branches, all pure, dispatches the entire auth posture), `interpolateEnv` + per-entry `.env` isolation (the "highest-risk piece" per CLAUDE.md), and `BUNDLE_DEV_OVERRIDE_*` (the dev/prod parity story for Type 3 bundles). Start there.

### Why these are the right defaults

- **Pure surfaces win first.** The `⭐ PURE` markers above are the only
  surfaces where adding a test costs ~30–80 lines and zero infrastructure.
  Integration-shaped surfaces (real subprocesses, real WebSockets, real
  HTTP) cost an order of magnitude more for the same regression-protection
  payoff — defer until a manual finding makes the investment worth it.
- **Pin invariants, not behavior.** A test that asserts "function returns
  X for input Y" can be regenerated from source. A test that asserts "this
  branch must NOT call markRejected, because the asymmetry is what makes
  recovery automatic" is what survives a refactor.
- **Don't pre-emptively build an integration harness.** The plan
  deliberately skips spawner / TunnelClient / dispatcher / inspector HTTP
  — when a manual finding surfaces a bug in one of them, the harness
  decision lands with the bug context, not before.

## Test catalog — defensive tests as they land

Each row: when added, what manual scenario triggered it, the source file under test, the bug or invariant being pinned, and current status. Keep this **chronological** — most recent at the top — so the "what's recently been a problem area" signal is easy to read.

| Date | Scenario observed (manual) | File under test | Test file | Bug / invariant | Status |
|------|----------------------------|-----------------|-----------------|-----------|-----------------|--------|
| 2026-07-20 | Operator's connector logged a full 10-line pino stack trace on every controller-restart / ngrok cycle. The `catch` in both `connectTunnel` closures (env-mode + db-mode) called `log.error({err: error as Error}, "tunnel connect failed")` — pino intercepts any field literally named `err` and runs it through `stdSerializers.err`, which inlines the stack. Recovery is automatic (the next log line schedules an auto-reconnect), so the stack was noise. Fix branch `fix/tunnel-connect-graceful-log`. | `src/boot/lifecycle.ts` (both `connectTunnel` catch blocks — env-mode and db-mode); `src/tunnel/format-log.ts` (new helper extracted for testability) | `tests/tunnel/format-log.test.ts` (5 cases — Error message extraction, dial-timeout wording, non-Error coercion for string/number/object/undefined, **`err`-field-absence regression pin** to guard pino's stack-serializer reintroduction, exact `{reason, url}` key set) | (1) **Field-name discipline.** Any pino payload named `err` triggers stdSerializers.err's stack inlining. For expected transient failures (WS 502 during controller restart, dial timeout, ECONNREFUSED, DNS blip) that's log spam. Route recoverable errors through `formatHandshakeFailure(error, url)` → `{reason: message, url}`; keep `{err}` for genuinely unexpected mid-session errors (`pendingTunnel.onerror`). (2) **Level too.** WARN, not ERROR — the pairing INFO line schedules the auto-reconnect, so the failure is a known-good branch, not an incident. Message string suffix `— auto-reconnect scheduled` makes the pairing readable end-to-end. (3) **Non-recoverable rejections stay loud.** `unknown_registration_token` from register-ack flows through `reconnectCtl.markRejected()` and the existing `auto-reconnect suppressed` WARN — not this helper. Don't widen the helper's usage into paths where a stack trace is actually useful. | passing |
| 2026-06-27 | TWILIO-MCP-BREAKOUT (branch `feature/twilio-mcp-breakout`) lifted the Twilio (21 tools) + SendGrid (4 tools) tools AND 12 prompts (4 service overviews + 7 agent-pay + 1 email overview) to @deshartman/twilio-mcp, and the Segment (5 tools + 1 overview prompt) tools to @deshartman/segment-mcp. The shim's `mcp/bundled/twilio/` (the `apis` MCP) stays unchanged. Defensive test pins the file-level inventory of every tool AND prompt lifted so a future contributor cannot rename / add / remove either kind of file in the bundle without realising the standalone repos need a coordinated update. | `mcp/bundled/twilio/<service>/{tools,prompts}/*.ts` (service-first layout: messaging / voice / verify / lookups / email / segment) + `mcp/bundled/twilio/{twilio-client,sendgrid-client,status-callback,segment-profile-client,segment-tracker}.ts` (READ-ONLY from this plan's perspective — the test asserts what's there, doesn't change it) | `packages/connector/tests/mcp-tools/apis/lift-inventory.test.ts` (4 describe blocks: twilio-mcp tools = 4+13+3+1+4 + 3 client wrappers; twilio-mcp prompts = 1+8+1+1+1 = 12 prompt files; segment-mcp = 5 tools + 1 prompt + 2 client wrappers; MCP-name contract pins "twilio" + "segment" as the standalone wire names). 15 assertions across 4 describe blocks. | (1) **Inventory drift is silent.** If a tool or prompt is added / renamed / split in the bundle without updating the standalone repo, the controller's procedures resolve the OLD name against the OLD copy — masked by Type 2 stdio's stateless dispatch. The test fails the moment any file list changes, forcing the contributor to acknowledge the standalone repo. (2) **Agent-pay is a coupled flow.** The 5 agent_pay_* tools and 7 agent_pay_* prompts ship together — pinning both lists in the same suite ensures a contributor who adds a 6th capture step (e.g. `agent_pay_capture_postcode`) catches the matching prompt requirement at test time, not at controller-load time. (3) **Names are the wire contract.** "twilio" + "segment" are the values the controller uses for matching, auto-fill, and procedure hydration. Renaming either in the standalone repos breaks every existing procedure that references those qualifiers. (4) **The shim's `apis` MCP keeps that name.** No conflict because the standalone repos and the shim's bundle are never running in the same process — the bundle is in-process Type 1, the standalone repos are out-of-process Type 2 stdio. | passing |
| 2026-06-26 | After a clean reconnect against a controller that had `crm` and `sample` already approved, the inspector showed `crm` Live (7 tools) and `sample` Orphaned (0 tools). Boot log: `mcp-discovered fan-out complete announced: 1, totalDropins: 2`. Root cause: `announceDiscoveredDropins` in lifecycle.ts checked `approval.isApproved(name)` inside the loop — while iteration 1 was suspended at `await supervisor.fetchEnvKeys(crm)`, the controller's replayed `mcp-enable` frames landed synchronously on the WS router (which calls `approval.handleEnable` → `approved.add` synchronously). By the time iteration 2 ran, both names were in the approved set; iter 2 hit the gate and skipped. The controller never saw `mcp-discovered` for sample this session, so its Live/Orphaned classifier (approved + seen-this-session → Live; approved + not-seen → Orphaned) parked sample as Orphaned. Fix branch `fix/mcp-discovered-fanout-race`. | `src/boot/announce-dropins.ts` (new — fan-out loop extracted from `lifecycle.ts` so it's testable without booting the process); `src/boot/lifecycle.ts` (now delegates to the extracted function; mid-loop `isApproved` gate removed) | `tests/boot/announce-dropins.test.ts` (4 cases — happy path emits for both drop-ins; **REGRESSION**: a `fetchEnvKeys` hook fires `handleEnable` for both names while iter 1 is suspended, and the second iteration still emits (would have failed with `announced: 1` under the buggy gate); fetchEnvKeys-throws skips one and continues; empty input returns `{announced:0, totalDropins:0}`). Confirmed: temporarily reintroducing `if (approval.isApproved(name)) continue` makes the REGRESSION case fail with the same `announced: 1` symptom the manual log showed. | (1) **`mcp-discovered` is a presence-this-session beacon, not a consent solicitation.** The controller uses each frame for TWO jobs: (a) replay `mcp-enable` for previously-approved MCPs, and (b) flip the row from Orphaned to Live in the inspector UI. Treating it as solicitation-only and short-circuiting "already approved" drop-ins breaks (b). (2) **Don't gate inside a loop with `await`s on a synchronously-mutated shared set.** `approval.approved.add(...)` runs inside the WS frame router (fire-and-forget, but the mutation is sync), so any check after an `await` can see writes that happened while the loop was suspended. The cure here was to drop the gate entirely (the approved set starts empty at process boot, so the gate could never legitimately filter anything); the general lesson is "snapshot the iterable before the first await, or eliminate the cross-await read." (3) **Fan-out frame redundancy is free.** `emitDiscovered` is documented as idempotent on the controller side per [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) §"v1.3" — the gate was a premature optimization protecting against a non-issue, while creating the bug. | passing |
| 2026-06-23 | Segment APIs added to the `apis` bundle on `feature/segment-mcp` to expose unified-customer-data lookups (Profile API: traits, events, external_ids) and write-back (Tracking API: identify, track) to controller-side procedures. Adopts the existing two-group creds-gate pattern — Twilio + SendGrid + Segment-read + Segment-write are four independent groups, each registers tools only when its env keys are present. Profile API has no Node SDK on npm (verified `@segment/profiles` 404), so reads use native fetch with HTTP Basic; writes use the official `@segment/analytics-node` v3 SDK. See [`.claude/plans/Done/SEGMENT-MCP.md`](Done/SEGMENT-MCP.md). | `mcp/bundled/twilio/segment-profile-client.ts` (new — fetch wrapper, 404 → `null`, otherwise throws with body); `mcp/bundled/twilio/segment-tracker.ts` (new — `Analytics` factory with `flushAt: 1` so per-call delivery is awaitable); `mcp/bundled/twilio/server.ts` (extended creds gate from 2 → 4 groups); `mcp/bundled/twilio/tools/segment/{segment_profile_traits,segment_profile_events,segment_profile_external_ids,segment_identify,segment_track}.ts`; `mcp/bundled/twilio/package.json` (`@segment/analytics-node ^3.1.0` dep) | `packages/connector/tests/mcp-tools/apis/segment/{segment_profile_traits,segment_profile_events,segment_profile_external_ids,segment_identify,segment_track}.test.ts` (5 files — happy-path structuredContent round-trip per tool; profile-not-found → `{found:false}` for traits; cursor surfacing on events; one-of userId/anonymousId enforcement on identify + track; SDK callback error → tool rejects on track) | (1) **`flushAt: 1` is load-bearing for the write tools.** The default SDK `flushAt: 15` would buffer events and the tool callback would resolve before delivery — breaking the procedure-author contract "tool returned → write happened". Don't bump this. (2) **404 → `{found:false}`, every other 4xx/5xx → throw.** Cold profile lookups for unknown phones are expected; surfacing them as `found:false` lets procedures branch without exception handling. Other errors must surface so credential / network problems don't masquerade as "no profile". (3) **Generic `id_type:value` lookup**, not per-id-type tools — mirrors Segment's URL shape and keeps the tool count down. Adding per-id sugar later is purely additive. (4) **Operator-entered creds, not auto-filled.** Segment isn't part of the tunnel-security row identity; `docs/MCP-PROTOCOL.md` §"Twilio-bundled auto-fill" carries the matching rule. The connector's `creds-request` for these envKeys gets `source: "operator-entered"`, NOT `"twilio-tunnel-row"`. (5) **Each Segment group registers independently.** A read-only customer (just `SEGMENT_SPACE_ID` + `SEGMENT_PROFILE_PAT`) sees the 3 read tools; a write-only customer sees the 2 write tools. Within a group it's still all-or-nothing — providing `SEGMENT_SPACE_ID` without `SEGMENT_PROFILE_PAT` registers zero read tools. (6) **`SEGMENT_PROFILE_HOST` is the EU-residency knob.** Defaults to `https://profiles.segment.com` (US); EU workspaces set `https://profiles.euw1.segment.com`. Per-region knob lives in the client, not the tools, so adding a region doesn't fan out across 3 tool files. | passing |
| 2026-06-23 | v1.3 customer drop-in approval gate shipped end-to-end (`feature/mcp-creds-config` merged main as `f90cbff`). Closed the asymmetry between customer drop-ins (auto-enabled before this) and 3rd-party MCPs (already operator-gated). Connector spawns child + lists tools but withholds from manifest until `mcp-enable` arrives; controller is durable authority for approval state, replayed via `mcp-enable` after every `register-ack`; disable is manifest-visibility-only (child keeps running, sub-second re-enable). Manual smoke against the controller's legacy-fallback path: `sample` flipped from Orphaned → Live after a v1.3 connector boot. See `.claude/plans/Done/MCP-CUSTOM-APPROVAL.md` and `docs/MCP-PROTOCOL.md` §"v1.3". | `src/tunnel/frames.ts` (4 frame types — `McpDiscoveredFrame`, `McpEnableFrame`, `McpDisableFrame`, `McpEnableAckFrame` — added to inbound/outbound discriminated unions); new `src/tunnel/approval-coordinator.ts` (process-wide, rebound per-tunnel via `bind({send})`); `src/manifest/build.ts` (optional `isApproved` predicate + drop-in name map; binary omit-or-include for `__dropin === true` specs only); `src/boot/lifecycle.ts` (instantiates `ApprovalCoordinator`, threads `isApproved` through every `buildManifest` call site, routes `mcp-enable` / `mcp-disable` via `pendingTunnel.onframe`, fans out `mcp-discovered` after register-ack via `announceDiscoveredDropins()`, gates inspector `toolDispatch` so the loopback UI cannot bypass the gate); `src/tunnel/local-mcps-coordinator.ts` `onMcpAdded` discriminates `source === "local"` drop-ins (announce path) from yaml-listed Type 1 hand-written entries (creds-request path). | `tests/tunnel/frames-v1_3.test.ts` (11 cases — round-trip JSON for each new frame, type-level membership in InboundTunnelFrame/TunnelFrame, presence-of-`stop`-absence pin on `mcp-disable`); `tests/tunnel/approval-coordinator.test.ts` (17 cases across 5 describe blocks — emitDiscovered shape; handleEnable flips approved + applies env + acks with toolsCount, idempotent replay, unknown_mcp / yaml not_gated / controller-config not_gated rejection, applyControllerEnv-failure rollback for first-time approval AND preservation for re-enable, frame-ordering pin via deferred `onManifestChange`; handleDisable clears approved + acks disabled with no spawn touched, never-approved is no-op, re-enable-after-disable is spawn-free; bind({send}) swaps wire callback without resetting approved set; wire-frame discriminator regression pin); `tests/manifest/build-approval-gate.test.ts` (6 cases — drop-in NOT in `isApproved` is omitted; drop-in approved includes full schemas; yaml-listed never gated regardless of `isApproved`; missing `isApproved` callback preserves pre-v1.3 behaviour; missing dropin map preserves pre-v1.3 behaviour; `dropinSpecsToMap` filters non-drop-in specs); `tests/tunnel/approval-flow-end-to-end.test.ts` (5 cases composing ApprovalCoordinator + buildManifest + diffManifest like lifecycle.ts does — initial manifest excludes drop-in, mcp-enable adds via manifest-delta BEFORE the ack, mcp-disable removes via manifest-delta BEFORE the ack, re-enable post-disable is spawn-free, mcp-discovered shape pin). 39 new tests across 4 files. | (1) **Approval state is controller-only.** Connector keeps no persistence in `.connector-state.json`. Controller replays `mcp-enable` after every register-ack — symmetric with v1.1 3rd-party roster. Don't add approval persistence. (2) **Gate predicate is `author === "customer" && source === "local"`** — codified in `dropinSpecsByName` map (constructed from `discoverDropins()` output) threaded through every `buildManifest` call. Yaml-listed and `controller-config` MCPs bypass the gate entirely. (3) **Manifest-delta MUST precede `mcp-enable-ack`** — pinned by the frame-ordering test that delays `onManifestChange` and asserts the ack waits. The ack is the "I'm done" signal, the manifest-delta is the actual surface change; reversing the order produces a TOCTOU window where the controller sees "ready" before the new tools land. (4) **Disable keeps child running** (DA5). No `stop` field on `mcp-disable`; kill-the-child is reserved for a future `mcp-stop` if a real scenario emerges. The "no spawn on re-enable" assertion is what makes the sub-second guarantee testable. (5) **Inspector toolDispatch filter is the trust-boundary backstop.** The inspector's tool-invocation panel rejects calls to unapproved drop-ins — without it, the loopback UI would be a backdoor around the operator's accept gesture. (6) **`mcp-enable` is approval-time; `creds-update` is steady-state.** The connector handles them through different code paths (approval coordinator vs creds coordinator) so a future controller-side conflation is detectable on the wire. (7) **ApprovalCoordinator lifetime is process-wide, NOT per-tunnel** (matches `McpConfigCoordinator` + `LocalMcpsCoordinator`). The approved set is the gate moment-to-moment; clearing on reconnect would flicker manifest tools off until the controller's replay completed. The `bind({send})` swap-without-reset test pins this. | passing |
| 2026-06-22 | INSPECTOR-CREDS-VISIBILITY landed (`feature/inspector-creds-visibility`). New surface: developer-pasted session creds via the inspector loopback UI for local smoke-testing before an admin pastes creds in the controller. Highest-stakes change — the inspector is now a brand-new cred-handling surface, so the test pack pins every leak channel before merge. Also surfaced a latent drop-in bug: `MCP_DROPIN_DIR` pointing OUTSIDE the repo (e.g. `/tmp/customer-mcps/` or production's `/var/lib/mcp-connector/customer-mcps/`) caused child crashes with `Cannot find module 'zod'` because Node's parent-dir climb couldn't reach the workspace's hoisted `node_modules`. | `src/mcp-supervisor.ts` (sessionEnv private layer + `applySessionEnv(name, env, {mode})` + `clearSessionEnv` + 12h `setTimeout` + `McpStatus.{credsSource,sessionCredsExpiresAt,sessionEnvKeys}` + `NODE_PATH=DROPIN_NODE_PATH` for drop-in spawns); `src/inspector/server.ts` (3 new write-only routes + `mcpActions.{applySessionCreds,clearSessionCreds,fetchEnvKeys}`); `src/boot/lifecycle.ts` (wiring); `src/manifest/build.ts` (`ServerDescriptor.envKeys` aggregation); `src/tunnel/frames.ts` (`ServerDescriptor.envKeys` field); `src/logger.ts` (Pino `redact.paths` allowlist); `public/{app.js,style.css}` (click-target split, right-pane creds view, redacted "set" placeholder, "Awaiting config" badge, per-tool verdict downgrade) | `tests/mcp-supervisor/session-env.test.ts` (11 cases — buffered apply when no spawn yet, controller+session merge label, Decision #1 controller-wins-per-key, clear restores prior label, TTL expiry triggers auto-clear via test-only `ttlMs` knob, re-apply resets timer, empty-payload no-op, unknown-MCP `applied:false`, **L7 leak**: `statusList` doesn't expose values, `sessionEnvKeys` carries names only, `clearSessionEnv` removes them); `tests/inspector/session-creds-leak.test.ts` (11 cases — **L1** apply response, **L2** clear + sibling routes, **L3** SSE event payloads, **L4** frame log, **L5** manifest, **L6** pino captures, **L8** disk grep across `src/`, plus 3 route-validation cases); `tests/logger/redact.test.ts` (4 cases — top-level env / controllerEnv / sessionEnv / spec.headers.authorization / common cred-shaped names; non-sensitive fields pass through). 26 new tests across 3 files. | (1) **Controller wins per-key.** Merge order is `process.env ⊕ spec.env ⊕ sessionEnv ⊕ controllerEnv` — controller layer is last, session layer fills *gaps* the controller hasn't covered. (2) **No value read-back, ever.** Routes are write-only — `POST /mcp/session-creds-apply` returns `{ok, expiresAt}` only; there is no `GET /mcp/session-creds`. The `applySessionCreds` interface signature reflects this — env in, expiry out. (3) **Names not values across every output channel.** `McpStatus.sessionEnvKeys: string[]` carries paste names so the UI can render `•••• (set)` placeholder; values stay private to the supervisor's `entry.sessionEnv` map. (4) **12h hard TTL from paste, not sliding.** Re-paste resets the timer; idle activity does not. Per-MCP `setTimeout` is `.unref()`'d so the connector can exit on idle. (5) **Apply mode "merge" for the inspector route.** Lets a partial form submit overwrite only typed-in fields (so `••• (set)` rows survive untouched). Default mode "replace" preserves backward compat for tests + supervisor-internal callers. (6) **NODE_PATH for drop-in spawns.** `computeDropinNodePath()` walks ancestors of the supervisor's own `import.meta.url` and joins every `node_modules` it finds with the platform delimiter; passed to drop-in children's spawn env. Mirrors how `tsx` already resolves the connector's own deps; restores parent-dir climb behaviour for drop-in folders that live outside the repo (`/tmp/customer-mcps/` in dev, `/var/lib/mcp-connector/customer-mcps/` in production). (7) **Pino redact backstop.** `redact.paths` allowlist on the root logger covers known sensitive paths (`env`, `controllerEnv`, `sessionEnv`, `headers.authorization`, common cred-shaped field names). Belt-and-braces — the production discipline is "don't log values" — but it catches accidental `log.info({env}, ...)` slips. CLAUDE.md "Architecturally load-bearing properties" carries the matching session-creds bullet. | passing |
| 2026-06-22 | `feature/mcp-client-use` + `feature/mcp-loading-local` merged into `mcp-shim-merge`. Combined surface needed: (a) drop-in runner extended to scan `prompts/` + `resources/` siblings of `tools/` so CLIENT-USE's worked example (`mcp/local/sample/{prompts,resources}/`) survives the LOCAL drop-in migration; (b) S7 boot smoke surfaced a tsx CJS-bridge bug — when `dist/sdk/dropin-discovery.js` is loaded as a CJS dep, dynamic `import()` of a `.ts` tool file reports the wrong namespace shape under `Object.values()`, breaking `pickShape`'s named-export fallback for `mcp/local/crm/`'s tools (which have no `export default`). | `packages/connector/src/sdk/dropin-runner.ts`, `packages/connector/src/sdk/dropin-discovery.ts` (new), `packages/connector/package.json` (`"type": "module"`), `packages/connector/src/dropin.ts`, `packages/connector/src/inspector/server.ts`, `packages/connector/src/mcp-supervisor.ts` | `tests/sdk/dropin-discovery.test.ts` (4 cases — picks up tools/prompts/resources independently; missing subdirs return `[]`; named-export fallback when no default; per-file isolation when one file's shape is bad) | (a) Runner discovery extracted to `dropin-discovery.ts` so `loadCategory<T>(dir, subdir, singular, isShape, log)` is unit-testable without spawning a real child. Test fixtures use `mkdtempSync` + `writeFileSync` per test (no shared `tests/helpers/` factory yet — promote when a second test needs it). (b) Connector flipped from CJS-emit to native ESM by setting `"type": "module"` in `packages/connector/package.json`; tsconfig was already on `module: NodeNext`. ESM removes the CJS-bridge so the runner's named-export fallback works under tsx for crm. Source touch-ups: 2× `__dirname` in `dropin.ts`, 1× in `inspector/server.ts` → `fileURLToPath(import.meta.url)`; `require.resolve("tsx/package.json")` in `mcp-supervisor.ts` → `createRequire(import.meta.url)`. CLAUDE.md "Workspaces" carries the don't-reintroduce-CJS rule. | passing |
| 2026-06-21 | W-E3 + W-E4 + W-E5 + W-E6 land together (controller-driven 3rd-party MCP roster — auth attachment + transport coverage + inspector badge). End-to-end manual exercise pending: today's verified path is stdio + auth:none (the aviation-weather flow), so HTTP-Bearer / HTTP-Header / OAuth2 / SSE / WebSocket transports are pinned by unit tests against the helpers + dispatch table only. The defensive suites are the regression contract while the manual flows mature. | `src/auth/resolve-mcp-auth.ts`, `src/auth/resolve-mcp-auth-async.ts`, `src/servers/sse.ts`, `src/servers/websocket.ts`, `src/servers/connect.ts`, `src/mcp-supervisor.ts`, `src/tunnel/mcp-config-coordinator.ts` | `tests/auth/resolve-mcp-auth.test.ts` (11 cases — all `McpAuthSpec` branches incl. empty-string-as-missing); `tests/auth/resolve-mcp-auth-async.test.ts` (10 cases — cache reuse on identical env, slot invalidation on each of clientId/clientSecret/tokenUrl change, mint-failure eviction with recovery, no-secret-leak in error string, request-shape pin); `tests/servers/connect-dispatch.test.ts` (6 cases — `__transportKind` dispatch + spec.headers passthrough); `tests/tunnel/mcp-config-coordinator.test.ts` (1 new case asserting sse/websocket entries register + start with `__transportKind` stamped); `tests/mcp-supervisor/status-source.test.ts` (5 cases — `register` defaults to yaml, `registerOne` meta plumbing, mcpId stays undefined when meta omits it). | (a) `resolveAuthHeaders(authSpec, env)` is the synchronous resolver for `none` / `bearer` / `header`; supervisor calls it inside `startEntry` before `connectServer` so a creds-update→restart cycle re-resolves naturally. Empty-string env values treated as missing (matches `stripEmptyValues` at the wire boundary — defensive against a controller-side regression that violates the omit-absent-keys rule in `docs/MCP-PROTOCOL.md`). (b) OAuth2 cache key = `${tokenUrl} ${clientId} ${clientSecret}`; rotation invalidates by mismatch, mint failure evicts, request body must be `grant_type=client_credentials` form-urlencoded. Strategy: mint-at-connect, restart-on-401 (chosen over fetch-override wrapper to avoid coupling to SDK transport internals). (c) Wire-side `transport` (http / streamable-http / sse / websocket / stdio) collapses to two-valued supervisor `McpServerSpec` with sub-transport on `__transportKind` (mirrors `__dropin` / `__port`). WebSocket caveat: SDK transport accepts only URL — custom headers dropped with a warn; auth must be embedded in the URL. (d) `McpStatus.source: "yaml" \| "controller-config"` + optional `mcpId` lets the inspector render the right badge; `register()` defaults to yaml, coordinator passes `{source, mcpId}` through `registerOne`. | passing |
| 2026-06-21 | Operator created a 3rd-party `time` MCP via the controller UI; controller ack'd back `status: failed, error: "name conflict with yaml entry \"time\""` even though there's no `time` entry anywhere in `connector.yaml`. Repro: tunnel had cycled (ngrok re-mint) between operator's "delete prior `time` row" and "add new `time` row" — the connector still had the prior session's `time` running in the supervisor but the new per-tunnel `McpConfigCoordinator` had an empty roster, so its addEntry path saw `supervisor.hasEntry("time") → true` AND `nameToMcpId.get("time") → undefined` and reported the only-other-error-message it had: yaml-clash. The "Removed" loop on the gen=N snapshot also never ran because the coordinator didn't know about the prior entry. End result: every reconnect leaked roster state and false yaml-clashes started failing legitimate adds. | `packages/connector/src/tunnel/mcp-config-coordinator.ts`, `packages/connector/src/boot/lifecycle.ts` | `tests/tunnel/mcp-config-coordinator.test.ts` (3 reconnect-survival cases: roster persists across `bind()`, post-reconnect snapshot omitting prior entry calls `supervisor.unregister`, snapshot-wait timer is cancelled by `bind()`) | Coordinator is now constructed ONCE in outer `boot()` scope (alongside the supervisor it tracks); per-tunnel rebind goes through `bind({send})` which only swaps the wire callback and cancels any in-flight snapshot-wait timer. Roster + `lastAppliedGeneration` survive WS reconnect by design — the LIFETIME comment at the top of `mcp-config-coordinator.ts` carries the matching invariant + the "why CredsCoordinator's per-tunnel construction is correct and this isn't" rationale. Naming: `armBootSoftWait` → `armSnapshotWait` (re-armable across reconnects, so "boot" was misleading). | passing |
| 2026-06-21 | First end-to-end exercise of the v1.1 controller-driven 3rd-party MCP roster: operator added `aviation-weather` (stdio, auth=none, `npx --yes aviation-weather-mcp`) and `time` (stdio, `uvx mcp-server-time`) via the controller UI; both registered cleanly into the connector's manifest, dispatched tool round-trips (`wx_metar KJFK` returned a live METAR, `get_current_time America/New_York` returned an ISO timestamp), then the operator deleted `aviation-weather` and the connector re-emitted a manifest without it while leaving the other 5 MCPs untouched. Wired the v1.1 protocol's load-bearing pieces with defensive tests at the time of that manual run. | `packages/connector/src/tunnel/mcp-config-coordinator.ts` | `tests/tunnel/mcp-config-coordinator.test.ts` (17 baseline cases across 6 describe blocks: snapshot reconcile add/remove/no-op/superseded; delta CRUD with mcpId-not-name remove + gap→resync + idempotent unknown-remove; yaml-vs-roster-clash error message asymmetry; sse/websocket/missing-field skipped paths; `mcpIdFor()` lookup for creds-request enrichment; snapshot-wait timer arm/cancel/re-arm) | Pins the load-bearing v1.1 invariants: (1) `mcpId` is the routing key for removes — controller never sends names in `removed[]`; (2) yaml entries are immune to controller-roster operations and produce a `failed` ack with a yaml-specific error message (collision with another roster entry references the OTHER mcpId, distinguishing the two clash modes); (3) generation gap → `mcp-config-resync { reason: "gap" }`, no silent desync; (4) snapshot-wait timer fires once on register-ack to surface older-controller silence as `mcp-config-resync { reason: "boot" }`; (5) `mcpIdFor(name)` returns `undefined` for yaml-listed names so creds-coordinator falls back to `(connectorId, mcp)` routing instead of `(connectorId, mcpId)`. CLAUDE.md "v1.1 — 3rd-party MCP roster" + `docs/MCP-PROTOCOL.md` carry the matching wire-format rules. | passing |
| 2026-06-21 | Boot crash on `./scripts/start-connector.sh` after deleting `mcp/bundled/twilio/.env` (testing the "no .env, ever" path under MCP-LOADING). Two distinct latent bugs in the connector spawn pipeline surfaced once the bundle started registering zero tools: (1) `tools/list` returned `-32601 Method not found` because `McpServer` wires its handler lazily on first `registerTool()` — a tools-empty server crashed `buildManifest`; (2) after a `creds-response` arrived with real Twilio creds for the `apis` MCP, the supervisor killed the running child but then tried to *connect* to the freed port instead of respawning → `connect ECONNREFUSED 127.0.0.1:7102`. | `packages/connector/src/sdk/http-server.ts`, `packages/connector/src/mcp-supervisor.ts` | `tests/sdk/http-server-empty-tools.test.ts` (2 cases), `tests/mcp-supervisor/apply-controller-env.test.ts` ("stopEntry clears spec.endpoint and __port" case) | (1) `createMcpHttpServer` installs an explicit `ListToolsRequestSchema` handler returning `{tools: []}` when `opts.tools.length === 0`; the second test case pins the gate so a future refactor doesn't shadow the SDK's own handler when tools exist. (2) `stopEntry` deletes `spec.endpoint` + `spec.__port` when `__port` is set so the next `startEntry` re-classifies the entry as a spawn (`isType1Spawn` checks "http + dir + **no** endpoint"). The `__port` gate keeps Type 2 http entries' author-supplied endpoints untouched. CLAUDE.md `mcp-supervisor.ts` entry carries the matching "spawn-mutation invariant" rule. | passing |
| 2026-06-21 | Doc audit found a name mismatch: `docs/MCP-PROTOCOL.md` Twilio-bundled auto-fill table listed `TWILIO_API_KEY` / `TWILIO_API_SECRET`, but `mcp/bundled/twilio/twilio-client.ts` read `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`. Latent — masked because no Twilio tool has declared `envKeys` yet, so the controller never auto-fills and the bundle silently falls through to `TWILIO_AUTH_TOKEN`. Decision: drop API Key from the bundle entirely (Option C) so the bundle and the auto-fill table agree on AuthToken-only. | `mcp/bundled/twilio/twilio-client.ts` | `tests/mcp-tools/apis/twilio-client.test.ts` (4 cases) | Bundle is AuthToken-only: requires `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`, throws on missing either, **ignores `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`** (the previously-supported API-Key branch is gone). The "ignores API Key" case is the load-bearing one — a future contributor reintroducing the branch silently re-creates the wire-format mismatch with `docs/MCP-PROTOCOL.md` auto-fill; this case fails noisily when that happens. CLAUDE.md `mcp/bundled/twilio` entry carries the matching "don't reintroduce" rule with the why. | passing |
| 2026-06-20 | Operator's network blipped at 05:27. Connector started auto-reconnect; second attempt hung for **3min 58sec** before ECONNRESET (kernel TCP timeout). During the hang the inspector showed the last successful tunnel-open timestamp (no live state), the operator clicked Reconnect, and nothing happened — no log line, no fresh frame, no UI change. Three orthogonal bugs: (1) WS dial had no timeout, (2) manual Reconnect early-returned silently when `reconnecting=true`, (3) Reconnect button reset its label after 1500ms regardless of dial outcome. | `src/tunnel/client.ts` (dial-timeout); `src/boot/lifecycle.ts` (manual override); `public/app.js` + `public/style.css` (UX) | `tests/tunnel/client-dial-timeout.test.ts` (1 case) | `client.ts` now caps the dial at 10s via `setTimeout` + `ws.terminate()` — pinned by a test that stands up an HTTP server which TCP-accepts but never answers the upgrade and asserts rejection within ~12s. `lifecycle.ts` `reconnect()` now takes `{ manual?: boolean }`; manual clicks bypass the `if (reconnecting) return` guard, log a line, and proceed (the close-then-redial naturally aborts the in-flight WS). `app.js` drops the 1500ms timer; the button stays disabled + 'reconnecting…' until SSE pushes `state: open` or `state: closed`. Status pill bumped to 0.85rem with a coloured dot + pulse animation while connecting/reconnecting; locked to top-right with `flex-shrink: 0` so it can't wrap off-screen. The lifecycle override decision is internal closure state — not unit-pinned; the bug recurrence will be caught by manual repro of "click Reconnect during a stuck dial" against the inspector. | passing |
| 2026-06-19 | Controller-side procedure author wrote `{{ hydrate:crm.get_customer.name }}` and saw no projection. Two independent reasons: (a) most tools shipped without an `outputSchema` (no autocomplete, no type-check), (b) handlers returned the customer record as a JSON string inside `content[0].text` rather than as `structuredContent` — the controller's `projectPath()` reads top-level fields, not `JSON.parse(content[0].text)`. Bringing every Type 1 / Type 3 tool into the get_recent.ts pattern fixes both. | every Type 1 / Type 3 tool under `mcp/local/{crm,sample}/tools/` and `mcp/bundled/twilio/tools/`; new `src/manifest/validate.ts` | `tests/manifest/validate.test.ts` (8 cases — original 6 plus 2 added during follow-up) + `tests/mcp-tools/{crm,sample,apis}/**/*.test.ts` (39 handler tests as of 2026-06-22 — drift count grew with later per-tool additions; not all 39 cases exist for every tool, some carry multiple cases per file) | All authored tools declare an `outputSchema` and populate `structuredContent` on the success path; error envelopes (no_customer / amount_exceeds_order_total / slot_taken / 409 ErrorBody) flow through `content[]` only — pinning rule #5 (SDK validates structuredContent against outputSchema even when isError, so an error envelope shape would fail validation). Boot-time validator at `src/manifest/validate.ts` logs `error` per offending Type 1/3 tool (does NOT throw — connector keeps booting; the broken tool just won't support hydration); Type 2 externals pass through silently because the controller handles them gracefully. CI is the primary line of defense via the per-tool tests; the boot log.error is the runtime backstop. | passing |
| 2026-06-18 | Audit of every `process.env` reader surfaced 5 surfaces using nullish coalescing (`?? DEFAULT`) which silently treated blank-line `.env` overrides as "set". Worst offender: `CONNECTOR_STATE_PATH=` (blank) caused `state.ts` to write state to `process.cwd()` instead of the documented default. Other surfaces silently coerced non-numeric env values to `NaN`/`0` via `Number(?? N)`. | `src/env.ts` (new), all `process.env` readers in `src/` | `tests/env.test.ts`, `tests/state/state-env.test.ts` | Single connector-wide rule centralized in `src/env.ts`: empty-string env var == not set, fall back to default. `envNumber` throws on non-numeric values with the var name + recovery hint. All 8 call sites converted (`state.ts`, `spawner.ts`, `logger.ts`, `boot/lifecycle.ts`, `index.ts`, `discover.ts`, `sdk/http-server.ts`, `sdk/webhook.ts`). Yaml `${VAR}` is the documented exception (substitutes literal then schema-validates). | passing |
| 2026-06-18 | Same boot log: register-ack with a freshly-minted token persisted to disk (`register-ack ok — persisted registrationToken`); a redundant register-ack on reconnect would not have re-written the file. | `src/tunnel/frame-router.ts` | `tests/tunnel/frame-router.test.ts` | Success path writes `.connector-state.json` only when `frame.registrationToken !== state.registrationToken`. Removing the guard would churn the disk on every register-ack (every reconnect, every controller restart). | passing |
| 2026-06-18 | Boot log: `webhook-allocate-ack` and `webhook` frames must reach the webhook registry, never the register-ack handler. | `src/tunnel/frame-router.ts` | `tests/tunnel/frame-router.test.ts` | Frame-type ordering at `frame-router.ts:43-50` is load-bearing — a webhook-allocate-ack racing register-ack must dispatch as a webhook, not be misclassified. Heartbeat / rpc / manifest-delta / goodbye are silent no-ops here (handled elsewhere on the TunnelClient). | passing |

When adding a row:

- **Test file** path is `packages/connector/tests/<area>/<unit>.test.ts` mirroring `src/`. e.g. a bug in `src/tunnel/reconnect.ts` → `tests/tunnel/reconnect.test.ts`.
- **Status** values: `failing` (red bar reproduces the bug), `passing` (fix landed, test pins the regression), `flaky` (open — investigation needed), `quarantined` (skipped with `it.skip` and a tracking note in the row).
- If multiple tests land for the same file, append rows rather than collapsing — each is its own scenario with its own root cause.

## Likely first targets — menu, not a roadmap

These are the surfaces CODE_HYGINE Step 5+ left in test-friendly shape. Listed here so the *first* manual-found bug doesn't have to also do the structural work to make its surface testable. Use as a hint for where a reproduction is likely to land.

- **`src/boot/auth.ts` `resolveAuth(env)`** — pure over an injected env map. The two postures (OAuth2 vs static bearer) and the boot-fail-when-neither path are the obvious branches. Likely surface for "set the wrong env var combo and nothing happens" scenarios.
- **`src/tunnel/reconnect.ts` `ReconnectController`** — class with no module state. Backoff invariants (floor = `initial_backoff_ms`, ceiling = `max_backoff_ms`, never below floor on an early-attempt draw, attempt counter resets on `markAccepted()`, suppression survives until `clearRejected()`). Decorrelated jitter has a randomness component — seed via injected RNG or assert range membership rather than exact values.
- **`src/tunnel/frame-router.ts`** — pure dispatch over an opts bag. Each frame variant maps to a specific set of side effects on the fakes. Highest-value branches: the `register-ack` error sub-table (`unknown_registration_token` clears state, `name_taken` calls `markRejected()`, generic also calls `markRejected()`), and the success path that persists a freshly-minted token.
- **`src/config.ts` `loadConfig`** — per-entry env precedence is the highest-risk piece per CLAUDE.md. Worth a test asserting that two MCP entries with `dir/.env` files declaring the same var get isolated environments. Also: zod-4's `.default(() => Schema.parse({}))` thunk-parse fix from Step 0c — a `policy: {}` yaml entry must round-trip to a fully-defaulted policy at runtime.
- **`src/manifest/diff.ts`** — pure functions (`diffManifest`, `isEmptyDelta`). Easy targets for "change in description text shouldn't show up in delta" / "schema shape change does show up" / "tool removal lands in `removed`".
- **`src/state.ts`** — `readState` / `writeState` / `clearRegistrationToken`. Atomic-rename invariant under crash (write-tmp + rename), clears-by-removing-file behavior, malformed-JSON throw shape. Worth pinning because the controller-rejection self-heal path (frame-router → state) depends on these primitives behaving exactly as documented.
- **`src/policy/redact.ts`** — three-arm switch (`none` / `redacted` / `full`) over arbitrary args. Trivial but a good first test if the prep round needs more confidence.
- **`src/servers/index.ts` `toDescriptor`** — wraps an MCP SDK tool shape into the wire `ToolDescriptor`. Pure; one-liner-ish test confirms `allowed: true` is always set (the trust-boundary rule from CLAUDE.md).

The surfaces deliberately *not* on this list — boot lifecycle, spawner, inspector HTTP routes, dispatcher live RPC — need fakes for `Client` / child-process / HTTP transport before they can be tested. Defer until a manual finding makes the investment worth it.

## Out of scope

- **Integration tests against a live controller.** The controller is offline by user design (working on it in parallel). When it's back, the four high-priority smoke tests at the bottom of CODE_HYGINE.md "What was NOT verified" remain manual until automation has a story for spinning the controller up in CI.
- **End-to-end MCP roundtrip tests.** Same reason. The dispatcher's `/tool/call` HTTP route is the headless substitute today; it's exercised manually via the inspector.
- **Property-based testing** (fast-check, etc.). Pure-function targets like the backoff curve are good fits but introducing a new framework before the first vitest test even lands is premature. Revisit if the suite grows past ~20 tests.
- **Snapshot tests.** No HTML / large JSON output surfaces in this repo (the inspector UI is the only HTML and it's manually verified). Not introducing snapshot tooling.
- **Logger DI threading.** CODE_HYGINE Step 3 deferred this. When the first defensive test wants to assert log-line shape (e.g. "the `name_taken` warning includes the connector name"), pick this up — until then it's overhead.

## File-by-file change list (prep round)

1. `vitest.config.ts` — update include glob from `packages/connector/src/**/*.test.ts` → `packages/connector/tests/**/*.test.ts`; update the comment header to describe the peer-tests layout.
2. `packages/connector/tests/sentinel.test.ts` — new file, ~5 lines, sentinel.

No `package.json` change. The existing `npm test` script in `packages/connector/package.json` (`vitest run --root ../.. --passWithNoTests`) already does the right thing.
