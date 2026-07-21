# Testing — Connector Lifecycle Defensive Tests

> **Status: completed 2026-06-19.**

> **Branch.** `feature/testing`, cut from `main` at 02ec331. The frame-router
> tests (Step 8) already landed on main; this plan covers the next layer:
> defensive tests over the connector's boot lifecycle and steady-state
> primitives.
>
> **Discipline.** Regression-driven, not coverage-driven, per
> [TEST-SUITE.md](TEST-SUITE.md). Each test below pins a documented
> load-bearing invariant — either a CLAUDE.md call-out, a "fail loudly"
> defensive check with an inline comment explaining why, or a behavior we
> watched fire on 2026-06-18. **No tests for tests' sake.**
>
> **Architectural context.** The connector lifecycle map, boot fingerprint
> baseline, and phase→test mapping live in
> [TEST-SUITE.md](TEST-SUITE.md#connector-lifecycle-map). Read those before
> writing test code — they explain *which* phases of the connector are
> testable as pure functions, which need fakes, and which are deferred.
> This plan only covers the next four tests on `feature/testing`.

## Context

`feature/code-hygine` is now on main, including the vitest skeleton (Step 7)
and the first defensive test for `frame-router.ts` (Step 8 — 8 tests, all
passing). The boot lifecycle below frame-router has no tests yet.

We mapped the lifecycle (Phases 0–9) and identified four surfaces where a
future refactor could erode an invariant we'd never catch in dev:

1. `boot/auth.ts` — three-branch posture dispatch with one "throw if neither"
   fail-fast that's the difference between a silently-unauthenticated
   connector and a clear boot error
2. `config.ts` — per-entry env isolation, called out by CLAUDE.md as "the
   highest-risk piece" because a `dotenv.config({path})` refactor would
   silently break it
3. `auth/oauth-provider.ts` — JWT cache + the explicit `expires_in ≥ 60`
   floor that prevents a tight refresh loop
4. `tunnel/reconnect.ts` — decorrelated-jitter backoff bounds + idempotency
   semantics

Surfaces deliberately out of scope: spawner, TunnelClient, dispatcher,
inspector HTTP — they need real subprocesses / WebSockets / HTTP and the
plan defers them until a manual finding justifies the investment. The full
phase→testability map lives in
[TEST-SUITE.md "Connector lifecycle map"](TEST-SUITE.md#connector-lifecycle-map).

## File-by-file targets

Each test file is self-contained: explicit `import { describe, it, expect } from "vitest"`,
no globals, fakes built inline (no shared `tests/helpers/` yet — wait until
the second test needs the same factory per [TEST-SUITE.md](TEST-SUITE.md#p3)).

Tests are listed in priority order. Land them as separate commits so each
catalog row in [TEST-SUITE.md](TEST-SUITE.md) maps 1:1 to a commit.

### T1. `tests/boot/auth.test.ts` ⭐ highest payoff

**Pins:** `boot/auth.ts` `resolveAuth(configToken, env)` — pure function over
an injected env map. Three branches; the "throw if neither" branch is
explicitly fail-safe per CLAUDE.md "WS-handshake auth is per-tunnel".

**Why now:** the boot log on 2026-06-18 hit the static-bearer branch
(`authToken: "set (len=84)"`). The OAuth2 branch is the one a refactor most
easily breaks because no manual scenario exercises it today — the test is
the only thing that does.

**Cases (~6, ~50 lines):**

1. OAuth2 posture (`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_TOKEN_URL`
   set) → returns `{ authProvider, authToken: undefined, status: "oauth2 ..." }`.
   Status string contains the clientId so the boot log identifies the row.
2. OAuth2 missing `OAUTH_CLIENT_SECRET` → throws with message naming the
   specific missing var (operator-actionable).
3. OAuth2 missing `OAUTH_TOKEN_URL` → throws likewise.
4. Static-bearer (no `OAUTH_CLIENT_ID`, configToken provided) → returns
   `{ authToken, authProvider: undefined, status: "set (len=N)" }`. N matches
   the configToken length.
5. Neither posture (no `OAUTH_CLIENT_ID`, configToken absent) → throws with
   the symmetric "set TUNNEL_AUTH_TOKEN or OAUTH_CLIENT_ID..." message.
6. **Both set** (`OAUTH_CLIENT_ID` present + configToken present) → OAuth2 wins.
   Precedence is an invariant — a refactor that flips the order would silently
   downgrade OAuth2 deployments to static bearer.

**No fakes needed.** Pass an env-shaped record literal; the
`OAuthClientCredentialsProvider` constructor doesn't make network calls.

### T2. `tests/config/load-config.test.ts` ⭐ highest-risk piece per CLAUDE.md

**Pins:** `config.ts` `loadConfig(yamlPath)` per-entry env isolation. CLAUDE.md
is explicit: "the highest-risk piece... Don't replace the per-spec env map
with calls to `dotenv.config({path: ...})` in `loadConfig` — that mutates
process.env and breaks the isolation guarantee." That kind of inline
refactor warning is exactly what a regression test exists to enforce.

**Why now:** also pins the zod-4 thunk-parse fix from Step 0c (`policy: {}`
→ fully-defaulted policy) and the line-numbered interpolation error message
that operators rely on.

**Cases (~5, ~80 lines):**

1. Two entries each with `dir/.env` declaring the **same** var name
   (`API_TOKEN=...`) → `spec[0].env.API_TOKEN ≠ spec[1].env.API_TOKEN`, AND
   `process.env.API_TOKEN` remains undefined after load.
2. Yaml inline `env:` overrides `dir/.env` for the same var (yaml takes
   precedence, per the comment at config.ts:258).
3. `policy: {}` round-trips to a fully-defaulted policy object — every
   field present with the documented default. Pin the thunk-parse fix.
4. `${UNSET_VAR}` interpolation throws with the var name AND the 1-based
   YAML line in the message (operator-actionable error).
5. `${VAR:-default}` falls back to the literal default when var is unset.

**Fakes:** `mkdtempSync` + write fixture yaml + `dir/.env` files + cleanup
in `afterEach`. Same pattern as the frame-router test's tmpdir setup.

### T3. `tests/auth/oauth-provider.test.ts`

**Pins:** `auth/oauth-provider.ts` `accessToken()` — JWT cache + 60s headroom
+ `expires_in ≥ 60` floor + secret-leak prevention.

**Why now:** the 60s headroom and `expires_in` floor are silent
defensives. If a refactor removes either:
- No headroom → connector mints a fresh JWT every reconnect (cheap on Mac,
  observable on Fargate where every reconnect = a controller round-trip).
- No floor → controller-side regression returning `expires_in: 30` causes
  a tight refresh loop instead of a clear error.

The "we never log client_secret or the JWT" rule from the inline comment
needs an anti-leak test — a refactor that adds `err.message` to a thrown
Error including the request body would be silently catastrophic.

**Cases (~7, ~70 lines):**

1. First call → POSTs `grant_type=client_credentials` to `tokenUrl` with
   `Content-Type: application/x-www-form-urlencoded`, returns the
   `access_token` from the response.
2. Second call within `expires_in - 60s` headroom → no second `fetch` call
   (cache hit).
3. Second call when cached token has < 60s of life left → fresh fetch
   (cache miss on the headroom edge).
4. Server returns `expires_in: 30` → throws with the floor message
   ("expected positive integer seconds ≥ 60").
5. Server returns `expires_in` missing/non-numeric → throws with the floor
   message.
6. Server returns HTTP 401 → throws `OAuth token mint failed: 401`. Verify
   the thrown message does NOT include `client_secret`.
7. Verify the request body does include `client_secret` (proves we send it)
   — but the thrown error from case 6 must not.

**Fakes:** `vi.spyOn(globalThis, "fetch")` returning canned `Response` objects.
Standard vitest pattern; no new devDeps.

### T4. `tests/tunnel/reconnect.test.ts`

**Pins:** `tunnel/reconnect.ts` `ReconnectController` — decorrelated jitter
bounds + schedule idempotency + max_attempts giveup.

**Why now:** the only randomness in the entire connector lives here. The
invariants are:
- delay ≥ `initial_backoff_ms` always (floor)
- delay ≤ `max_backoff_ms` always (ceiling)
- climbs monotonically up to ceiling on a sequence of failures
- `markAccepted()` resets `lastDelay` so the next outage starts at floor
- `schedule()` while a timer is pending is a no-op (both ws 'error' and
  'close' fire on a failed dial; we must not double-increment `attempt`)

A refactor that subtly inverts the `Math.max` arg order or drops the
`Math.min` cap would cause one of: floor violations (fast retries hammering
the controller), ceiling violations (10-minute backoffs on a 30s policy).

**Why this is also on the plan's "first targets" list:** see
[TEST-SUITE.md "Likely first targets"](TEST-SUITE.md#likely-first-targets--menu-not-a-roadmap).
The plan calls out "decorrelated jitter has a randomness component — seed
via injected RNG or assert range membership rather than exact values." We
go the assert-range-membership route since `Math.random` is easy to spy.

**Cases (~7, ~70 lines):**

1. With `Math.random` stubbed to 0, delay = `initial_backoff_ms` exactly
   (floor is inclusive).
2. With `Math.random` stubbed to 1, delay ≤ `max_backoff_ms` (ceiling).
3. After 10 sequential schedule() calls with random=1, delay sequence is
   monotonically non-decreasing AND terminates at `max_backoff_ms` AND
   never exceeds it.
4. `markAccepted()` after several attempts → `attemptCount() === 0`,
   `lastDelay` reset (next schedule draws from the floor again).
5. `schedule()` while timer is pending is a no-op (`attempt` doesn't
   advance on the second call). Today's boot exercises this on every
   failed dial — both 'error' and 'close' route through `schedule()`.
6. `cancel()` clears the pending timer; subsequent `schedule()` works.
7. Policy with `max_attempts: 3` → fourth `schedule()` logs "gave up",
   does not start a timer, resets attempt counter.

**Fakes:** stub `Math.random` via `vi.spyOn(Math, "random")`; `vi.useFakeTimers()`
to drive the `setTimeout` deterministically; spy `getPolicy` and
`onFire` callbacks; tiny fake logger same shape as frame-router tests.

## Out of scope (and why)

| Surface | Why deferred |
|---------|--------------|
| `manifest/diff.ts` | Pure, but no real bug found yet, no scenario triggered. Adding it now is "tests for tests' sake." Land if a manifest-diff bug surfaces. |
| `policy/redact.ts` three-arm switch | Trivial. The plan says "a good first test if the prep round needs more confidence" — we've moved past that. |
| `manifest/build.ts buildManifest` | Mostly orchestration over `authorOf` + `listTools`. The interesting branch is a defensive default for a "should always exist" lookup miss — pinning a fallback nobody currently relies on. |
| `state.ts` directly | Already exercised through tests 1–3 of frame-router.test.ts via real fs paths. Standalone tests redundant unless a malformed-JSON boot scenario surfaces. |
| `servers/index.ts toDescriptor` | One-liner; pinning `allowed: true` is on the trust-boundary contract list. **Borderline** — skipping to keep regression-driven discipline. |
| Spawner / TunnelClient / dispatcher / inspector HTTP | Need real subprocesses / WebSockets / HTTP. Plan defers until a manual finding justifies the investment. |

## Verification

After each test file lands:

```bash
cd packages/connector && npm test                                   # all green
cd /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim && npm run build  # tsc -b clean
ls packages/connector/dist/ | grep -E '\.test\.|^tests' && echo LEAKED || echo "no leak (correct)"
```

After all four:

```bash
./scripts/start-connector.sh    # one boot round-trip, manual sanity check
```

## Commits and catalog

One commit per test file. After each commit, append a row to the
[TEST-SUITE.md catalog](TEST-SUITE.md#test-catalog--defensive-tests-as-they-land)
with the date, scenario (the CLAUDE.md call-out or invariant being pinned),
file under test, test file path, bug/invariant, and status `passing`.

Suggested commit titles:

- `Step 9: defensive test — boot/auth.ts posture dispatch`
- `Step 10: defensive test — config.ts per-entry env isolation`
- `Step 11: defensive test — oauth-provider.ts cache + floor + secret hygiene`
- `Step 12: defensive test — reconnect.ts jitter bounds + idempotency`

Net cost: 4 new test files, ~270 lines total, no new devDeps. Each test
maps to a documented load-bearing invariant.

## When this plan is "done"

All four tests land, all four catalog rows appear, suite stays green
through one fresh `./scripts/start-connector.sh` round-trip. Then this
file gets a "Done" header at the top and we either merge to main or wait
for the next manual finding to drive Step 13 onward.
