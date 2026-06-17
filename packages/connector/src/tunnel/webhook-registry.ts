// Per-connector registry of webhook allocations.
//
// One instance lives in the connector main loop. It tracks which MCPs have
// asked for a public URL (via the SDK's createWebhookEndpoint), what URL the
// controller minted for each, and which in-process listeners are subscribed.
//
// Two separate concerns flow through here:
//   1. Tunnel side  — sends webhook-allocate / webhook-revoke frames out, and
//                     receives webhook-allocate-ack / webhook frames in.
//   2. Local IPC    — feeds the SDK (running in a bundled MCP child process)
//                     via the inspector loopback's SSE stream.
//
// Reconnect semantics: on tunnel close we keep the per-MCP listener entries
// (the SDK consumer is still alive in its child process and still wants
// callbacks), but drop the URLs (a closed WS means we can't deliver anything
// anyway). On tunnel reopen we eagerly re-issue webhook-allocate for every
// still-subscribed MCP. The controller's idempotency guarantee (same URL
// rowId across reissues, see STATUS-CALLBACK-CTRL.md "Idempotency vs URL
// stability") means pasted statusCallback URLs keep resolving across
// connector restarts.

import type {
  WebhookAllocateAckFrame,
  WebhookFrame,
  WebhookAllocateFrame,
  WebhookRevokeFrame,
} from "./frames.js";
import { createLogger, type Logger } from "../logger.js";

export interface WebhookEvent {
  body: unknown;
  queryParameters: Record<string, string | string[]>;
  headers?: Record<string, string>;
  receivedAt: number;
}

export type WebhookListener = (event: WebhookEvent) => void;
export type UrlListener = (url: string) => void;

export interface WebhookAllocation {
  mcp: string;
  url: string;
}

interface PendingAlloc {
  resolve: (url: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Subscription {
  mcp: string;
  url?: string;                       // undefined while WS is closed or pre-ack
  webhookListeners: Set<WebhookListener>;
  urlListeners: Set<UrlListener>;     // fired on (re)allocate so the SDK can surface fresh URLs
}

export interface WebhookRegistryOptions {
  // Outbound frame send. Returns false when the WS is not open; the registry
  // queues an eager re-allocate for the next tunnel open in that case.
  sendFrame: (frame: WebhookAllocateFrame | WebhookRevokeFrame) => boolean;
  // Allocation timeout. If the controller doesn't ack inside this window,
  // allocate() rejects.
  allocateTimeoutMs?: number;
  log?: Logger;
}

export class WebhookRegistry {
  private readonly subs = new Map<string, Subscription>();
  private readonly pending = new Map<string, PendingAlloc>();
  private readonly opts: WebhookRegistryOptions;
  private readonly log: Logger;
  private tunnelOpen = false;

  constructor(opts: WebhookRegistryOptions) {
    this.opts = opts;
    this.log = opts.log ?? createLogger("webhooks");
  }

  // Snapshot for the inspector UI. Returns one entry per allocated MCP with
  // its current URL (if minted) and listener counts.
  snapshot(): Array<{ mcp: string; url?: string; listeners: number }> {
    return [...this.subs.values()].map((s) => ({
      mcp: s.mcp,
      url: s.url,
      listeners: s.webhookListeners.size,
    }));
  }

  setTunnelOpen(open: boolean): void {
    this.tunnelOpen = open;
  }

  // Called by the connector right after register-ack succeeds (or any time
  // the WS comes back to a healthy state). Re-issues webhook-allocate for
  // every MCP that still has a live SDK listener — and re-fires any
  // allocate that was pending across the tunnel close (e.g. the SDK called
  // allocate before the tunnel ever opened, or while the controller was
  // mid-restart).
  //
  // The controller mints a fresh random tail on every webhook-allocate (rowId
  // is stable). When the new ack lands, onAllocateAck fans the new URL out to
  // sub.urlListeners — including the SSE handler's onUrl callback — which
  // pushes a fresh `event: url` over the loopback to the SDK in the child
  // process, which in turn updates its `currentUrl` and notifies any
  // consumer that called `endpoint.on('url', …)`. This is the only path
  // by which the SDK learns the URL changed; without it the SDK keeps
  // handing out the stale tail to Twilio configs.
  reallocateAll(): void {
    if (!this.tunnelOpen) return;
    // Re-fire every pending allocate (their timers were cleared by
    // onTunnelClose; the SDK promises are still alive). Subscriptions
    // without a pending entry get a fresh allocate via beginAllocate,
    // which adds a new pending entry of its own.
    const pendingMcps = new Set(this.pending.keys());
    for (const sub of this.subs.values()) {
      // Drop the prior URL — it's no longer authoritative until the controller
      // re-confirms. The SDK side may still cache it during the reopen window
      // (Twilio configs rarely change in seconds), but the registry shouldn't
      // claim it's live.
      sub.url = undefined;
      if (pendingMcps.has(sub.mcp)) {
        this.refirePending(sub.mcp);
        pendingMcps.delete(sub.mcp);
      } else {
        this.beginAllocate(sub.mcp).catch((e) => {
          this.log.error({ err: e as Error, mcp: sub.mcp }, `re-allocate failed on tunnel reopen`);
        });
      }
    }
    // Defensive: any orphaned pending (no matching sub) shouldn't exist
    // because subscribe() always creates a sub before begin, but if it
    // does, refire so we don't leave it hanging.
    for (const mcp of pendingMcps) {
      this.refirePending(mcp);
    }
  }

  // Re-arm the timer and re-send the wire frame for an allocate that was
  // already in `pending` when the tunnel closed. The Promise's resolve/reject
  // handles stay attached to the entry, so the same promise the SDK is
  // awaiting will fire when the new ack lands.
  private refirePending(mcp: string): void {
    const p = this.pending.get(mcp);
    if (!p) return;
    const timeoutMs = this.opts.allocateTimeoutMs ?? 10_000;
    p.timer = setTimeout(() => {
      this.pending.delete(mcp);
      p.reject(new Error(`webhook-allocate for "${mcp}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.opts.sendFrame({ type: "webhook-allocate", mcp });
  }

  // SDK side. Idempotent per `mcp`: a second call for the same MCP attaches
  // a new listener but does not trigger a fresh webhook-allocate frame.
  async subscribe(mcp: string, listener: WebhookListener): Promise<{ url: string; unsubscribe: () => void; onUrl: (fn: UrlListener) => () => void }> {
    let sub = this.subs.get(mcp);
    if (!sub) {
      sub = { mcp, webhookListeners: new Set(), urlListeners: new Set() };
      this.subs.set(mcp, sub);
    }
    sub.webhookListeners.add(listener);

    // If we already have a URL, hand it back. Otherwise allocate (or wait on
    // an in-flight allocate from a sibling subscriber).
    let url = sub.url;
    if (!url) {
      url = await this.beginAllocate(mcp);
    }

    const live = sub;
    return {
      url,
      unsubscribe: () => this.unsubscribe(mcp, listener),
      onUrl: (fn: UrlListener) => {
        live.urlListeners.add(fn);
        return () => live.urlListeners.delete(fn);
      },
    };
  }

  private unsubscribe(mcp: string, listener: WebhookListener): void {
    const sub = this.subs.get(mcp);
    if (!sub) return;
    sub.webhookListeners.delete(listener);
    if (sub.webhookListeners.size === 0 && sub.urlListeners.size === 0) {
      this.subs.delete(mcp);
      // Tell the controller we no longer need this URL. Best-effort: if the
      // tunnel is down the controller will GC by session anyway.
      if (this.tunnelOpen) {
        this.opts.sendFrame({ type: "webhook-revoke", mcp });
      }
    }
  }

  // Force-revoke an allocation regardless of listener count. Used by the
  // SDK's explicit teardown path. Idempotent.
  revoke(mcp: string): void {
    if (!this.subs.has(mcp)) return;
    this.subs.delete(mcp);
    if (this.tunnelOpen) {
      this.opts.sendFrame({ type: "webhook-revoke", mcp });
    }
  }

  // Inbound frame: the controller replied to our webhook-allocate.
  onAllocateAck(frame: WebhookAllocateAckFrame): void {
    const pending = this.pending.get(frame.mcp);
    if (!pending) {
      // Late ack (e.g. allocation timed out and we already rejected, or this
      // is an unsolicited re-mint from the controller). Update the URL on the
      // sub so URL listeners see the change.
      const sub = this.subs.get(frame.mcp);
      if (sub && frame.url) {
        sub.url = frame.url;
        for (const fn of sub.urlListeners) fn(frame.url);
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.mcp);

    if (frame.error) {
      pending.reject(new Error(`webhook-allocate rejected: ${frame.error.code} — ${frame.error.message}`));
      return;
    }
    if (!frame.url) {
      pending.reject(new Error(`webhook-allocate-ack: missing url`));
      return;
    }
    const sub = this.subs.get(frame.mcp);
    if (sub) {
      sub.url = frame.url;
      for (const fn of sub.urlListeners) fn(frame.url);
    }
    pending.resolve(frame.url);
  }

  // Inbound frame: a webhook arrived. Fan out to local listeners.
  dispatch(frame: WebhookFrame): void {
    const sub = this.subs.get(frame.mcp);
    if (!sub || sub.webhookListeners.size === 0) {
      // Unknown MCP, or one that the SDK hasn't subscribed to yet. We don't
      // NACK — the controller has already returned 200 to the upstream and
      // can't replay anyway. Log and drop.
      this.log.warn({ mcp: frame.mcp }, `webhook frame for MCP with no local listener — dropped`);
      return;
    }
    const event: WebhookEvent = {
      body: frame.body,
      queryParameters: frame.queryParameters,
      headers: frame.headers,
      receivedAt: frame.receivedAt,
    };
    for (const fn of sub.webhookListeners) {
      try { fn(event); }
      catch (e) { this.log.error({ err: e as Error, mcp: frame.mcp }, `webhook listener threw`); }
    }
  }

  // Pause in-flight allocates across a WS bounce. Called when the WS closes.
  // The Subscriptions stay so we can re-issue on reopen, AND so do the
  // pending promise handles — clearing only the timers. reallocateAll() on
  // reopen re-arms a fresh timer and re-sends the wire frame, so the same
  // SDK promise the caller is awaiting resolves once the new ack lands.
  //
  // Why not just reject? An operator-driven re-mint of the controller row
  // (or a transient ngrok bounce) closes the tunnel mid-allocate. Today's
  // boot order means the apis bundle's createWebhookEndpoint races with
  // the very first tunnel handshake — and in the
  // unknown_registration_token recovery path the connector closes the
  // tunnel deliberately so it can re-mint. Rejecting in that window would
  // be a permanent failure for the SDK consumer (its endpointPromise
  // resets to undefined and never re-allocates until a tool call triggers
  // it). Preserving the pending lets recovery be transparent.
  onTunnelClose(): void {
    this.tunnelOpen = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    // Pending entries stay; reallocateAll re-arms them. Mark all known
    // URLs as stale.
    for (const sub of this.subs.values()) sub.url = undefined;
  }

  private beginAllocate(mcp: string): Promise<string> {
    // Coalesce: if there's already a pending allocate for this MCP, return
    // the same promise instead of issuing a duplicate frame.
    const existing = this.pending.get(mcp);
    if (existing) {
      return new Promise<string>((resolve, reject) => {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (url) => { prevResolve(url); resolve(url); };
        existing.reject  = (err) => { prevReject(err);   reject(err); };
      });
    }

    return new Promise<string>((resolve, reject) => {
      const timeoutMs = this.opts.allocateTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        this.pending.delete(mcp);
        reject(new Error(`webhook-allocate for "${mcp}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(mcp, { resolve, reject, timer });

      const sent = this.opts.sendFrame({ type: "webhook-allocate", mcp });
      if (!sent) {
        // Tunnel is down; the WS reopen path (reallocateAll) will fire the
        // frame for us. Don't reject yet — let the timeout do that if reopen
        // doesn't happen in time.
        this.log.info({ mcp }, `webhook-allocate queued — tunnel not open yet`);
      }
    });
  }
}
