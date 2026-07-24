// Auto-reconnect controller. Owns reconnectAttempt, reconnectTimer,
// lastDelay, registrationRejected.
//
// Two events come in: a tunnel close / failed dial (`schedule()` — fires a
// timer that calls back to the supplied `onFire` after the next backoff),
// and a manual or successful-ack reset (`markAccepted()` / `markRejected()`).
// The controller is policy-aware via the ReconnectPolicyConfig handed in at
// construction; consumers don't need to thread that around.
//
// Backoff strategy: decorrelated jitter (AWS pattern). Each delay is drawn
// from uniform(initial_backoff_ms, lastDelay * 3), capped at max_backoff_ms.
// Climbs without synchronizing across many connectors recovering from the
// same outage. resetReconnectDelay() (called from the success path) brings
// the next blip back to the floor.

import type { ReconnectPolicyConfig } from "../config.js";
import type { Logger } from "../logger.js";

export interface ReconnectControllerOpts {
  // Policy comes from the live config object — the controller doesn't keep
  // its own copy because reconnect.enabled / max_attempts can change on a
  // YAML reload (only the policy block is hot-reloaded; mcp_servers needs a
  // restart). Pass a getter so the controller always reads the current
  // value rather than a snapshot frozen at construction time.
  getPolicy: () => ReconnectPolicyConfig;
  // Fires when the timer elapses. The caller is responsible for actually
  // reconnecting; this controller only schedules + tracks state.
  onFire: () => void;
  // Optional sink for the inspector "reconnecting in N.Ns · attempt K" pill.
  onReconnecting?: (info: { attempt: number; nextDelayMs: number }) => void;
  log: Logger;
}

export class ReconnectController {
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private lastDelay = 0;
  // Set when the controller actively rejects our register frame
  // (unknown_registration_token, name_taken). Suppresses the auto-reconnect
  // loop until cleared by markAccepted() (successful ack) or a manual
  // reconnect path explicitly clearing it (operator's signal that they've
  // fixed whatever caused the rejection).
  private rejected = false;

  constructor(private readonly opts: ReconnectControllerOpts) {}

  // True iff the controller has marked this connector as rejected. The
  // boot lifecycle reads this to decide whether to suppress an auto-fire
  // on a tunnel close.
  isRejected(): boolean {
    return this.rejected;
  }

  // Operator clicked Reconnect, or a successful ack came in — clear the
  // suppression. The next blip will resume the backoff curve from zero.
  clearRejected(): void {
    this.rejected = false;
  }

  // Current consecutive-attempt count. Read by the boot lifecycle to label
  // log lines on each auto-fire ("auto attempt N").
  attemptCount(): number {
    return this.attempt;
  }

  // Controller-side rejection. Don't auto-retry; operator intervention
  // required (clear .connector-state.json or fix CONNECTOR_NAME).
  markRejected(): void {
    this.rejected = true;
  }

  // Successful register-ack — reset attempt count and backoff curve so the
  // next outage starts fresh.
  markAccepted(): void {
    this.rejected = false;
    if (this.attempt > 0) {
      this.opts.log.info({ priorAttempts: this.attempt }, `tunnel healthy — reset reconnect attempts`);
      this.attempt = 0;
    }
    this.lastDelay = 0;
  }

  // Schedule the next auto-reconnect attempt. Idempotent: a failed dial
  // typically triggers both ws 'error' and ws 'close' which both call
  // through to here — the second call is a no-op so we don't
  // double-increment attempt or stomp the timer.
  schedule(): void {
    if (this.timer) return;
    const policy = this.opts.getPolicy();
    this.attempt += 1;
    if (policy.max_attempts > 0 && this.attempt > policy.max_attempts) {
      this.opts.log.warn(
        { maxAttempts: policy.max_attempts },
        `auto-reconnect: gave up; inspector stays in 'closed' until manual reconnect`,
      );
      this.attempt = 0;
      return;
    }
    const delayMs = this.nextDelay(policy);
    this.opts.log.info({ attempt: this.attempt, delayMs }, `auto-reconnect scheduled`);
    this.opts.onReconnecting?.({ attempt: this.attempt, nextDelayMs: delayMs });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.opts.onFire();
    }, delayMs);
  }

  // Cancel a pending auto-reconnect — used by SIGTERM/SIGINT and by the
  // manual reconnect path so a click fires immediately without stacking
  // a queued auto-fire on top of it.
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // Decorrelated-jitter delay for the next attempt. Reads policy fresh from
  // the getter each call so a YAML reload that updates initial_backoff_ms
  // takes effect on the very next computation.
  private nextDelay(policy: ReconnectPolicyConfig): number {
    if (this.lastDelay === 0) this.lastDelay = policy.initial_backoff_ms;
    const upper = Math.max(policy.initial_backoff_ms, this.lastDelay * 3);
    const span = upper - policy.initial_backoff_ms;
    const draw = policy.initial_backoff_ms + Math.floor(Math.random() * (span + 1));
    const next = Math.min(policy.max_backoff_ms, draw);
    this.lastDelay = next;
    return next;
  }
}
