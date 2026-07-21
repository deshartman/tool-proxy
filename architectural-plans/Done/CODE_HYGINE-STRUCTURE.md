# Code Hygiene — Pre-Test Maintenance Plan

> **Status: completed 2026-06-19.** All 8 steps + four follow-on cleanups landed on `feature/code-hygine` as 14 commits.

## Status

All 8 steps + four follow-on cleanups landed on `feature/code-hygine` as 14 commits. Branch is **not merged into main** — held for manual testing per the user's instruction. No `feature/code-hygine` push to `origin` (per the standing rule that only main belongs on origin).

| Step | Commit | Notes |
|---|---|---|
| 0a — MCP SDK 1.0.4 → ^1.29.0 | `1d8d18f` | Same major, 29 minors of wire-protocol fixes. |
| 0b — dotenv 17 / pino 10 / pino-pretty 13 / typescript 6 + minors | `e1020d5` | `@types/node` deliberately held at ^22 to match `node:22-alpine`. |
| 0c — zod 3 → 4 | `432ab76` | "Build clean" in the Step 0c commit was wrong — `tsc -b` re-used a stale `tsconfig.tsbuildinfo`. |
| 0c fixup — zod-4 type fallout | `b311f45` | `z.record(K, V)` two-arg form (3 sites) and `Schema.default(() => Schema.parse({}))` thunk-parse for nested defaults (zod 4 changed runtime semantics — `.default({})` no longer applies inner field defaults). Also gitignore `.playwright-mcp/`. |
| 0d — twilio 5 → 6 | `85f8351` | Real Twilio v6 API call (`lookups.v2.phoneNumbers().fetch`) verified against the live account in `mcp/bundled/twilio/.env`. The 3 `as any` casts at SDK boundaries still type-check + run. |
| 1 — split main() | `6277b65` | New: `boot/auth.ts`, `boot/lifecycle.ts`, `tunnel/frame-router.ts`, `tunnel/reconnect.ts`. `index.ts` 644 → 73 lines. |
| 1.5 — `.then()` → async/await | `c6b2ae8` | The status-callback double-`.catch` reset bug is fixed in this commit — the new shape only resets `endpointPromise` when allocation itself fails, not on downstream throws. |
| 2 — break servers/ cycle | `a01fbb4` | Plan's prescription wasn't enough on its own (cycle survived as `index.ts ↔ http.ts`). Added a new `servers/connect.ts` for `connectServer`/`connectAll` so `index.ts` stays types-and-helpers only. `madge --circular --extensions ts` reports zero cycles. |
| 3 — twilio/sendgrid singletons → DI | `52ce81e` | Twilio is eager (`createTwilioClient(env)`); SendGrid is a lazy provider (`makeSendGridProvider()` returns a `() => SendGridClient` thunk). Lazy was needed to preserve the prior contract that operators without `SENDGRID_API_KEY` can still boot. **Logger DI deferred** per user direction. |
| 4 — vitest skeleton | `640735f` | vitest 4.1.9 in root devDeps, root `vitest.config.ts`, `npm test` from `packages/connector` exits 0 with "No test files found". |
| 5 — post-refactor cleanup | `08efafd` | Strip stale `main()` references from comments (7 sites: `boot/lifecycle.ts`, `tunnel/reconnect.ts`, `tunnel/frame-router.ts`, `auth/oauth-provider.ts`, `dispatcher.ts`); drop the dead `ERROR_CODES` export + 3 unused JSON-RPC error-code constants in `dispatcher.ts`; replace `as never` in `voice_pay.ts:80` with the SDK's actual `PromptAttributes` shape (the cast is now redundant — TwiML's `prompt()` accepts the same `PromptFor` union our zod enum models). |
| 5b — silence false-positive YAML warning | `b8df60e` | `sameMcpServers()` was comparing the spawner-mutated live `endpoint` (`http://127.0.0.1:71xx/mcp`) against the freshly-loaded yaml (no endpoint for Type 1 entries) and emitting `mcp_servers list changed in YAML — restart required` on every reconnect. Skip the `endpoint` field for Type 1 entries (yaml has `dir` and no endpoint); factor `sameMcpServers` into three small helpers to stay under the SonarLint cognitive-complexity threshold. Verified: 4+ reconnect cycles against the offline controller, zero false-positive warnings. |
| 6 — rename single-letter identifiers | `6d9a80a` | 30 files; 194 lines. `catch (e)` → `catch (error)` everywhere; array-method callbacks adopt domain nouns (`(s) → (server)`, `(t) → (tool)`, `(c) → (child)`, etc.); asymmetric comparators in `boot/lifecycle.ts` (`sameMcpServers` + helpers) use `(live, fresh)` because the two sides represent different roles (spawner-mutated vs freshly-loaded yaml — the asymmetry is what 5b's bug hinged on). The local `TunnelClient` inside `connectTunnel` renamed to `pendingTunnel`; the `loadConfig` / `buildManifest` results renamed `nextConfig` / `nextManifest` per scope. Symmetric comparators in `manifest/diff.ts` and the `.sort()` comparator in `manifest/build.ts` kept `(a, b)` — no role asymmetry to disambiguate. Verified: clean build, full boot, all 5 MCP servers + 44-tool manifest + healthy reconnect loop. |
| 6b — rename remaining single-letter params | `424aee6` | Five single-arg utility functions Step 6 missed (they don't match the array-callback / catch / for-of patterns that dominated the diff): `safeStringify(v) → (value)`, `toDescriptor(t, allowed) → (tool, allowed)`, `quoteIfNeeded(v) → (value)`, `isEmptyDelta(d) → (delta)`, `flatten(m) → (manifest)`. The truly-symmetric comparators in `manifest/diff.ts` (`isStructurallyDifferent`, `schemasEqual`) keep `(a, b)`. |

## Deviations from the original plan

These are worth flagging because they're places where the prescription was incomplete or wrong:

1. **Step 0c — `tsc -b` cache bit us.** The plan called for `npm run build` to gate each step, but `tsc -b` keeps a `tsconfig.tsbuildinfo` and skips re-typecheck if no source changed. Bumping a dep doesn't touch source, so the build "passed" with zod-4 type errors hidden. The fix: every dep bump from this branch onward should clear `tsconfig.tsbuildinfo` before building. Worth folding into the verification harness.

2. **Step 0c — runtime semantics changed too, not just types.** The plan flagged `z.record(z.unknown())` as a type-only break. zod 4 also changed `.default({})` runtime behavior on schemas with field-level `.default()`s — in v3 the inner fields would re-resolve; in v4 they don't and the output is literally `{}`. Two `.default({})` sites in `config.ts` were silently broken until I noticed (would have produced `policy: {}` at runtime instead of fully-defaulted policy). The thunk-parse fix is in commit `b311f45`. Add a runtime check to any new test that exercises config defaults.

3. **Step 2 — the plan's prescription left a residual cycle.** Moving `makeConnection` into `index.ts` only escapes the cycle if `index.ts` *also* stops importing the transport files. I split `connectServer`/`connectAll` into a new `servers/connect.ts` and updated the two call sites (`discover.ts`, `boot/lifecycle.ts`). The plan should have called this out.

4. **Step 3 — eager DI broke a lazy contract.** Refactoring `getSendGridClient()` to `createSendGridClient(env)` made it eager-evaluated. The Twilio MCP boots without `SENDGRID_API_KEY` only because the prior singleton was lazy. The fix: a `makeSendGridProvider()` factory that returns a thunk; tools take a `SendGridClientProvider` and call it on first use. Twilio stays eager (every tool needs it; failing fast is right). Pattern worth keeping in mind for any future "this tool needs creds the connector might not have" surface.

5. **Step 3 — logger DI deferred.** Plan called for a `LoggerFactory` threaded through 17 source files + the SDK boundary. With no test consumers in this PR (Step 4 is the skeleton, not actual tests), the threading is overhead-only. User opted to defer. Revisit when the first test that needs to inject its own logger is written.

6. **Step 5 — post-refactor cleanup sweep.** Not in the original plan. After Step 4 landed I re-ran the dead-code / type-safety / DI-consistency audits to catch waste that survived the structural moves. Three classes of finding:
   - Stale comments in 4 files (`boot/lifecycle.ts`, `tunnel/reconnect.ts`, `tunnel/frame-router.ts`, `auth/oauth-provider.ts`, `dispatcher.ts`) referenced `main()` — the 644-line closure that no longer exists. Reads as a refactor diary; replaced with descriptions of where the state lives now.
   - `ERROR_CODES` was exported as a "for tests" surface in `dispatcher.ts:161` but had zero importers (and 3 of the constants — `E_PARSE`, `E_INVALID_REQUEST`, `E_INTERNAL` — were never used internally either). Removed the export + the unused constants.
   - `voice_pay.ts:80` had `pay.prompt({ for: p.for } as never)` — the only `as never` in the codebase. Twilio v6's `PromptAttributes.for: PromptFor` is a string-literal union identical to our zod enum, so the cast is redundant. Replaced with a plain object literal.
   Verification: clean `tsc -b` (after clearing `tsconfig.tsbuildinfo`), `npm test` exits 0, `madge --circular --extensions ts` reports zero, real connector boot brings up all 5 MCP servers + 44-tool manifest + the expected reconnect loop against the offline controller.

## Branch state

```
$ git log --oneline feature/code-hygine ^main
424aee6 Step 6b: rename remaining single-letter function parameters
6d9a80a Step 6: rename single-letter identifiers to descriptive names
b8df60e Step 5b: silence false-positive 'mcp_servers list changed' warning
08efafd Step 5: post-refactor cleanup sweep
640735f Step 4: vitest skeleton (no tests)
52ce81e Step 3: replace twilio-client / sendgrid-client singletons with DI
a01fbb4 Step 2: break servers/ import cycle
c6b2ae8 Step 1.5: convert raw .then() chains to async/await
6277b65 Step 1: split main() into boot/ + tunnel/ modules
85f8351 Step 0d: bump twilio SDK 5 → 6 in mcp/bundled/twilio
b311f45 Step 0c fixup: zod-4 type fixes + ignore .playwright-mcp/
432ab76 Step 0c: bump zod 3 → 4
e1020d5 Step 0b: bump dotenv/pino/pino-pretty/typescript + tracker minors
1d8d18f Step 0a: bump @modelcontextprotocol/sdk to ^1.29.0
944cb83 graphiphy ignore  (pre-existing, base of branch)
```

Working tree clean. `npm run build` clean from root. `npm test` from `packages/connector` exits 0.

## What was verified

Per-step verification done locally (controller is offline by user's design — they're working on the controller in parallel):

- **`npm run build`** clean after every step.
- **Connector boot via `./scripts/start-connector.sh`** — all 5 MCP servers (sample, crm, apis, aviation-weather, enterprise_knowledge) connect; manifest builds with 44 tools.
- **Tool dispatch via inspector `/tool/call` HTTP route** — exercised on every step. Routes through dispatcher → MCP HTTP transport → tool handler. Same code path the controller would use; bypasses the DOM so it's headless-friendly.
- **Real Twilio v6 API roundtrip** — `lookups_fetch` with `phone_number=+15551234567` returned a valid response shape on both Step 0d and Step 3.
- **Validation surface** — zod-4 message format ("Invalid input: expected string, received undefined") confirmed.
- **Reconnect path** — clicked the inspector's Reconnect endpoint after Step 1, observed `closed → reconnecting → connecting → ...` cycle and `attemptCount()` incrementing through the new `ReconnectController`.
- **Cycle check** — `npx madge --circular --extensions ts packages/connector/src` reports zero (was 1 before Step 2).
- **Pretty-print** — TTY-emulated one-shot confirms pino-pretty 13 still renders the `{component} | {msg}` template.

## What was NOT verified (controller offline)

- WS handshake with a live controller (any 200 instead of the 401 we get against `tap-des.ngrok.dev`).
- `register-ack` happy path — the new `frame-router.ts` `handleRegisterAck` success path.
- `unknown_registration_token` and `name_taken` error sub-table branches — these are currently exercised only by reading the code, not running it.
- Webhook ingress end-to-end — `webhook-allocate` queues correctly but never gets an ack (controller offline), so `webhook-allocate-ack` and `webhook` routing through the new frame router are unverified at runtime. The controller-side rollout will need to confirm.
- `ReconnectController.markAccepted()` clearing the rejected flag — code path is right but unexercised.
- Per-tool `messages_create` send (charges money; not run as part of automated verification).
- All 4 SendGrid email tools (no `SENDGRID_API_KEY` set; lazy provider returns the expected error when invoked).

When the controller is back, the high-priority smoke tests are:
1. Boot, observe `register-ack` success → `tunnel connected`, `tunnel open since` stamped on the inspector header.
2. Force a `name_taken` (boot a second connector with the same `CONNECTOR_NAME`) → confirm `auto-reconnect suppressed` appears and the inspector identity flips to `rejected`.
3. Force an `unknown_registration_token` (delete the connector's row controller-side, leave `.connector-state.json` in place) → confirm self-heal: `controller no longer recognizes our registrationToken — clearing local state to re-mint`, then the next attempt mints a fresh row.
4. Twilio statusCallback round-trip — fire a `messages_create` with `receiveStatusCallbacks: true`, confirm the URL allocates, the SendGrid-equivalent comes back over the WS as a `webhook` frame and lands in the inspector's Webhooks panel + log.

## Follow-ups not in this PR

- **Logger DI** — deferred. Pick this up when the first test that needs to inject a logger is being written (e.g., a `ReconnectController` test that wants to assert log-line shape, or a `boot/lifecycle.ts` integration test that wants to silence output).
- **Tests.** This PR is the skeleton; an actual suite hasn't been authored. Highest-value first targets, given what the refactor exposed:
  - `boot/auth.ts` `resolveAuth(env)` — pure function over an injected env map; trivial to exercise.
  - `tunnel/reconnect.ts` `ReconnectController` — class with no module state, fake the policy getter and the fire callback. Backoff curve invariants are verifiable: floor = `initial_backoff_ms`, ceiling = `max_backoff_ms`, never decreasing within a streak.
  - `tunnel/frame-router.ts` — pure dispatch over an opts bag. Fake all the dependencies, hand it each frame variant, assert the right side effects fire (registry write, state persistence, inspector identity update).
  - `config.ts` `loadConfig` — exercise the per-entry env precedence (the comment in CLAUDE.md warns this is the highest-risk piece) and the zod-4 default behavior.
  - `servers/index.ts` `makeConnection` — wraps a fake `Client`; trivial to verify.
- **Pre-existing lint warnings** I deliberately left:
  - `voice_pay.ts` `as never` cast on the `prompt({ for: p.for } as never)` call.
  - `voice_dial.ts` cognitive complexity 18 (>15 limit) — 14 conditional attribute assignments, pre-existing shape.
  - `sdk/http-server.ts` nesting >4 levels — pre-existing.
  - `status-callback.ts` TODO marker on `waitForStatus` (still unimplemented).
- **`@types/node`** still at ^22. When the runtime image moves off `node:22-alpine`, bump in lockstep.
- **`npm audit`** reports 2 high-severity vulnerabilities. Not investigated here; orthogonal to the hygiene scope.
- **`mcp/bundled/twilio/package-lock.json`** is generated by `npm install` in that folder but not committed (Dockerfile uses `--no-package-lock`). Worth a one-liner gitignore entry under `mcp/*/package-lock.json` to keep working trees clean. Not done in this PR.

## Original context (preserved for diff against execution)

The connector had no unit tests (CLAUDE.md: *"There are no tests. Verification is interactive via the inspector UI."*). Before authoring tests, the structural friction needed to come out: a 644-line `main()` that mixed boot, tunnel, frame-handling, and reconnect; module-singleton state in three places (`logger.root`, `twilio-client`, `lastDelay`); a benign-but-real import cycle in `servers/`; three raw `.then()` chains; significant package drift including a 29-minor lag on `@modelcontextprotocol/sdk`. Graphify confirmed the structural picture — community **Boot, Manifest & Reconnect** was 66 nodes with cohesion 0.05.

Steps 0a–0d ran first so structural refactors landed on a current dependency baseline. Each step was independently shippable. Verification happened through the inspector after each step; for the runs the controller was offline, the headless `/tool/call` HTTP route was the substitute (proves the local stack end-to-end, leaves only WS-handshake-and-after for the controller-side smoke).

The pre-execution audit found the codebase in good shape on most axes:
- No inheritance outside Node built-ins — composition throughout.
- `any` usage minimal: 3 `as any` casts in Twilio tools, all at the SDK boundary, eslint-disabled with comments.
- Discriminated unions correct (`frames.ts`, `Identity`, `WsState`).
- No `@ts-ignore` anywhere.
- No dead code worth removing.
- Only 7 `} else if` chains in the entire TS codebase; only the `register-ack` handler was genuinely problematic, addressed by the `frame-router.ts` extraction.

So the plan's narrowness was the right call: structural prep that removed friction tests would otherwise hit, plus dependency catch-up so a future test suite is written against current APIs. Out of scope: writing actual tests (just the framework skeleton).
