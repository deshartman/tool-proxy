# STABLE_TUNNEL_RECONNECT

Status: **done**

- [x] A. Self-heal `unknown_registration_token` (clear local state, no `registrationRejected`, retry as first-connect)
- [x] A'. `name_taken` keeps sticky but with action-oriented log + inspector message
- [x] B. Decorrelated jitter backoff (`min(max_backoff_ms, random(initial_backoff_ms, lastDelay*3))`)
- [x] C. Atomic state-file writes (tmp + rename) + `clearRegistrationToken` helper
- [x] D. Inspector identity status line (header pill: bound / first-connect / cleared / rejected)
- [x] **F. Bug fix found during verification** — `onclose` and the dial-`catch` were both gated on `if (shuttingDown || reconnecting) return`. Since `reconnecting=true` for the *whole duration* of an in-flight reconnect attempt, any failure during a reconnect (the most common case during a controller restart!) was being swallowed. After attempt-1 hit a 502 because the controller was still mid-restart, no attempt-2 was scheduled and the connector wedged in `closed`. Removed the `reconnecting` gate; made `scheduleAutoReconnect()` idempotent via a pending-timer check so the dual-fire (`error` + `close`) on a failed handshake doesn't double-schedule.
- [x] `npm run build` clean
- [x] Verified end-to-end against live controller. Recovery sequence observed: `tunnel closed → attempt 1 (2.4s) → 502 → attempt 2 (5.4s) → connected → bound to existing record`. Total ~8s through a full controller restart. No `.connector-state.json` deletion. Token reused.

## Context

The connector's WS tunnel reconnect is unreliable when the controller restarts. The user reports two recurring symptoms:

1. The controller comes back online, but the connector stays in `closed` and never redials.
2. `packages/connector/.connector-state.json` has to be deleted manually before the connector will re-bind.

Goal: a connector that **always re-establishes the tunnel without operator intervention, as long as the controller is reachable**, while still keeping the per-connector identity stable across normal restarts.

## Why it's flaky today

Three independent issues compound:

### 1. `registrationRejected` traps the connector forever

[`packages/connector/src/index.ts:170-223`](../../packages/connector/src/index.ts) sets a sticky `registrationRejected = true` flag whenever the controller returns *any* error in `register-ack`, and the `onclose` handler short-circuits auto-reconnect when it's set. The flag clears only on:
- a successful `register-ack` (impossible — we're not retrying), or
- a manual click on the inspector's Reconnect button.

The controller-side code at `AgenticProcedure/server/src/mcp/terminator.ts` returns these error codes:
- `unknown_registration_token` — the token in our state file doesn't resolve to a row in the controller DB
- `name_taken` — first-connect attempt with a name that's already bound to another row
- `missing_name_or_token` — protocol bug (won't happen in practice)
- `unknown_connector` / `register_failed` — legacy / catch-all

The **`unknown_registration_token`** path is the one the user is hitting. It triggers when the controller's DB is reset, the connector row is deleted, or the DB volume is fresh. Today's "fix" is exactly the operator workaround the user is tired of: delete `.connector-state.json` and click Reconnect. The retry then runs as a first-connect, mints a new row, and everything works.

### 2. The backoff curve is a fixed 1s delay

`nextReconnectDelay()` at [`index.ts:455-458`](../../packages/connector/src/index.ts) is a placeholder — it returns `policy.initial_backoff_ms` (default 1000ms) regardless of attempt count, ignoring `max_backoff_ms` entirely. During a long controller outage (e.g. ngrok cycle, deploy) this hammers the controller at 1Hz and the inspector's "next attempt in N.Ns" counter is misleading.

### 3. State file writes are not atomic

`writeState` uses a naive `writeFileSync` (no temp+rename). A crash mid-write — or a SIGTERM landing inside the `register-ack` handler — can leave the file truncated. `readState` swallows parse errors and treats it as missing, which usually self-heals via re-mint *unless* the controller still has the old row, in which case we re-mint a duplicate name → `name_taken` → see issue #1.

## Solution

Three changes, each independent:

### A. Self-heal `unknown_registration_token` (the headline fix)

In the `register-ack` handler at [`index.ts:256-283`](../../packages/connector/src/index.ts), special-case `frame.error.code === "unknown_registration_token"`:

1. Clear `state.registrationToken` in memory.
2. Delete (or rewrite without the token) `.connector-state.json` on disk.
3. **Do not** set `registrationRejected = true`.
4. Let the close handler fire and trigger `scheduleAutoReconnect()` as normal.

Next attempt boots with no token → controller mints a fresh row → bound. No operator action.

This matches what the operator does manually today, just done by the code.

**`name_taken` keeps sticky suppression**, but with a louder, action-oriented log line: `name "<X>" is already bound to another connector row — delete that row controller-side, or revert CONNECTOR_NAME`. Rationale: name collisions almost always mean a config mistake, not an outage; silently retrying would mask the misconfig.

Other error codes (`missing_name_or_token`, `unknown_connector`, `register_failed`) keep current sticky behaviour — they're either protocol bugs or unrecoverable.

### B. Real backoff curve

Replace `nextReconnectDelay()` with **decorrelated jitter** (AWS pattern), bounded by `[initial_backoff_ms, max_backoff_ms]`:

```ts
// Decorrelated jitter — smooth spread across many connectors recovering
// from the same outage, with a known floor and ceiling.
let lastDelay = policy.initial_backoff_ms;
function nextReconnectDelay(_attempt: number, policy: ReconnectPolicyConfig): number {
  const next = Math.min(policy.max_backoff_ms, randomBetween(policy.initial_backoff_ms, lastDelay * 3));
  lastDelay = next;
  return next;
}
```

Reset `lastDelay` to `initial_backoff_ms` on a successful `register-ack` (alongside `reconnectAttempt = 0` that already happens at [`index.ts:267-270`](../../packages/connector/src/index.ts)).

### C. Atomic state-file writes

In [`packages/connector/src/state.ts`](../../packages/connector/src/state.ts), change `writeState` from `writeFileSync(path, json)` to `writeFileSync(path + ".tmp", json) → renameSync(path + ".tmp", path)`. POSIX rename is atomic; readers see either the old file or the new file, never a partial. Negligible cost (one extra inode op).

### D. Inspector identity status line

In [`packages/connector/public/app.js`](../../packages/connector/public/app.js) and [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts), surface a one-line identity indicator near the controller URL:

- `identity: bound (token len=N)` — token present, last register-ack succeeded
- `identity: first-connect pending` — no token on disk
- `identity: cleared — controller rejected token, re-minting` — fix A just kicked in (transient, reverts to `bound` on next ack)
- `identity: rejected — name "<X>" already bound (action: delete controller row or change CONNECTOR_NAME)` — `name_taken` sticky state

The connector already has all this info in `state.registrationToken` and the `registrationRejected` flag. Add an `identity` field to the inspector view (alongside `state` / `manifest`) and broadcast it via the existing SSE channel. No wire-format changes.

## Files touched

- [`packages/connector/src/index.ts`](../../packages/connector/src/index.ts) — `register-ack` handler (A), `nextReconnectDelay` + `lastDelay` reset (B), feed identity status to inspector (D)
- [`packages/connector/src/state.ts`](../../packages/connector/src/state.ts) — atomic write (C), helper to clear token on disk (A)
- [`packages/connector/src/inspector/server.ts`](../../packages/connector/src/inspector/server.ts) — `identity` field in the broadcast view (D)
- [`packages/connector/public/app.js`](../../packages/connector/public/app.js) — render identity status line (D)
- No wire-format changes. No controller changes. No yaml schema changes.

## Verification

1. `npm run build` in repo root.
2. Boot connector against a live controller. Confirm `tunnel connected` + `register-ack ok`.
3. **Test A (unknown_registration_token):** stop the controller, wipe its connector DB row (or restart with a fresh DB), restart the controller. Watch the connector logs:
   - Expect: `register-ack rejected ... unknown_registration_token` → `clearing local registrationToken — controller no longer recognizes it` → next attempt: `register-ack ok — persisted registrationToken`. **No manual rm.**
4. **Test B (backoff):** stop the controller, leave it down for 2 min, watch the inspector's "next attempt in N.Ns" counter climb from ~1s toward `max_backoff_ms` (default 30s). Restart the controller; connector recovers within one backoff window.
5. **Test C (atomicity):** loop `kill -9 $(pgrep -f 'connector/dist/index')` during boot, restart. State file should always be parseable.
6. **Test D (inspector):** during tests A/B above, watch the inspector "identity" line transition: `bound → cleared → bound`.
7. **Test name_taken sticky:** start a second connector with the same `CONNECTOR_NAME` against the same controller. Second one should log the actionable message and *stay* in `closed` — confirms we didn't accidentally make all errors self-heal.
8. Through all three recoverable scenarios: the inspector pill should cycle `connecting → open` (or `closed → reconnecting → connecting → open`) without ever wedging in `closed`.

## Out of scope

- Replacing the inspector reconnect race (last-writer-wins) — purely cosmetic.
- Surfacing `register-ack` errors in the inspector frames panel (already there via `ontap`).
- Multi-pod state-file locking — the deployment shape is one container per `connector_id`, so concurrent writers don't happen.
