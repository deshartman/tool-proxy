import { describe, it, expect } from "vitest";

import { createFrameRouter } from "../../src/tunnel/frame-router.js";
import type { FrameRouterOpts } from "../../src/tunnel/frame-router.js";
import type {
  HeartbeatFrame,
  ManifestDeltaFrame,
  GoodbyeFrame,
  RegisterAckFrame,
  RpcFrame,
  WebhookAllocateAckFrame,
  WebhookFrame,
} from "../../src/tunnel/frames.js";

// Defensive tests for createFrameRouter. Pinned invariants:
//   * unknown_registration_token self-heal (the heart of automatic recovery
//     from controller DB resets) — clears the token, calls onTokenCleared,
//     does NOT mark rejected.
//   * register-ack success persists a freshly-minted token via onTokenMinted.
// The asymmetry between the three error branches — only
// unknown_registration_token avoids markRejected() — is exactly the kind of
// invariant a "tidying" refactor erodes. Pin it.
//
// Post env-mode-removal: persistence is via callback rather than the deleted
// state.ts file writer. The tokenRef object survives across calls so the
// register frame builder in bootFromDb can read the current value.

interface FakeWebhooks {
  setTunnelOpenCalls: boolean[];
  reallocateAllCount: number;
  allocateAcks: WebhookAllocateAckFrame[];
  dispatched: WebhookFrame[];
}
interface FakeReconnect {
  acceptedCount: number;
  rejectedCount: number;
}
interface FakeInspector {
  identityCalls: unknown[];
  headerCalls: unknown[];
}
interface FakeLog {
  info: { msg: string; ctx: unknown }[];
  warn: { msg: string; ctx: unknown }[];
  error: { msg: string; ctx: unknown }[];
}

interface Harness {
  router: (frame: import("../../src/tunnel/frames.js").InboundTunnelFrame) => void;
  webhooks: FakeWebhooks;
  reconnect: FakeReconnect;
  inspector: FakeInspector;
  log: FakeLog;
  tokenRef: { current: string | undefined };
  tokenMintedCalls: string[];
  tokenClearedCount: number;
}

function buildHarness(initialToken?: string, opts?: { withInspector?: boolean }): Harness {
  const withInspector = opts?.withInspector ?? true;
  const webhooks: FakeWebhooks = {
    setTunnelOpenCalls: [],
    reallocateAllCount: 0,
    allocateAcks: [],
    dispatched: [],
  };
  const reconnect: FakeReconnect = { acceptedCount: 0, rejectedCount: 0 };
  const inspector: FakeInspector = { identityCalls: [], headerCalls: [] };
  const log: FakeLog = { info: [], warn: [], error: [] };
  const tokenMintedCalls: string[] = [];
  let tokenClearedCount = 0;

  const fakeWebhooks = {
    onAllocateAck: (frame: WebhookAllocateAckFrame) => { webhooks.allocateAcks.push(frame); },
    dispatch: (frame: WebhookFrame) => { webhooks.dispatched.push(frame); },
    setTunnelOpen: (open: boolean) => { webhooks.setTunnelOpenCalls.push(open); },
    reallocateAll: () => { webhooks.reallocateAllCount += 1; },
  };
  const fakeReconnect = {
    markAccepted: () => { reconnect.acceptedCount += 1; },
    markRejected: () => { reconnect.rejectedCount += 1; },
  };
  const fakeInspector = withInspector ? {
    setIdentity: (identity: unknown) => { inspector.identityCalls.push(identity); },
    setHeader: (header: unknown) => { inspector.headerCalls.push(header); },
  } : undefined;
  // Pino supports both `log.info(msg)` and `log.info(ctx, msg)`. Handle both
  // shapes so tests are resilient to callers that omit the ctx object.
  const pushLog = (bucket: { msg: string; ctx: unknown }[]) =>
    (arg1: unknown, arg2?: string): void => {
      if (typeof arg1 === "string") {
        bucket.push({ ctx: undefined, msg: arg1 });
      } else {
        bucket.push({ ctx: arg1, msg: arg2 ?? "" });
      }
    };
  const fakeLog = {
    info: pushLog(log.info),
    warn: pushLog(log.warn),
    error: pushLog(log.error),
  };

  const tokenRef = { current: initialToken };

  const routerOpts: FrameRouterOpts = {
    webhooks: fakeWebhooks as unknown as FrameRouterOpts["webhooks"],
    tokenRef,
    onTokenMinted: (token: string) => { tokenMintedCalls.push(token); },
    onTokenCleared: () => { tokenClearedCount += 1; },
    inspector: fakeInspector as unknown as FrameRouterOpts["inspector"],
    reconnect: fakeReconnect as unknown as FrameRouterOpts["reconnect"],
    log: fakeLog as unknown as FrameRouterOpts["log"],
    connectorName: "test-connector",
  };

  return {
    router: createFrameRouter(routerOpts),
    webhooks,
    reconnect,
    inspector,
    log,
    tokenRef,
    tokenMintedCalls,
    get tokenClearedCount() { return tokenClearedCount; },
  };
}

describe("frame-router success path", () => {
  it("persists a freshly-minted token, resets reconnect, opens webhook delivery, and stamps inspector identity", () => {
    const h = buildHarness(undefined);
    const tok = "tok_freshly_minted_xxxxxxxxxxxxxxxxx";
    expect(tok).toHaveLength(36);
    const ack: RegisterAckFrame = {
      type: "register-ack",
      accepted: true,
      connectorId: "conn_abc123",
      registrationToken: tok,
    };

    h.router(ack);

    expect(h.reconnect.acceptedCount).toBe(1);
    expect(h.reconnect.rejectedCount).toBe(0);
    expect(h.webhooks.setTunnelOpenCalls).toEqual([true]);
    expect(h.webhooks.reallocateAllCount).toBe(1);

    // Token stamped into ref cell + onTokenMinted callback fired.
    expect(h.tokenRef.current).toBe(tok);
    expect(h.tokenMintedCalls).toEqual([tok]);

    expect(h.inspector.identityCalls).toEqual([{ kind: "bound", tokenLen: 36 }]);
    expect(h.inspector.headerCalls).toHaveLength(1);
    const header = h.inspector.headerCalls[0] as Record<string, string>;
    expect(header.connectorId).toBe("conn_abc123");
    expect(header.lastRegisterAckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // "token minted" log line fired (proves we took the mint branch, not the
    // "bound to existing record" branch).
    expect(h.log.info.some((line) => line.msg.includes("token minted"))).toBe(true);
  });

  it("does NOT re-fire onTokenMinted when the controller echoes back the same token", () => {
    const existing = "tok_already_persisted_36chars_xxxxxxxxxx";
    const h = buildHarness(existing);
    const ack: RegisterAckFrame = {
      type: "register-ack",
      accepted: true,
      connectorId: "conn_xyz",
      registrationToken: existing,
    };

    h.router(ack);

    expect(h.reconnect.acceptedCount).toBe(1);
    expect(h.webhooks.setTunnelOpenCalls).toEqual([true]);
    // onTokenMinted must NOT fire — refactoring the equality guard away
    // would churn the DB on every reconnect.
    expect(h.tokenMintedCalls).toEqual([]);
    // The "bound to existing record" log line fires instead of the mint line.
    expect(h.log.info.some((line) => line.msg.includes("bound to existing record"))).toBe(true);
    expect(h.log.info.some((line) => line.msg.includes("token minted"))).toBe(false);
  });
});

describe("frame-router register-ack error sub-table", () => {
  it("self-heals on unknown_registration_token: clears token via callback, does NOT mark rejected", () => {
    const h = buildHarness("tok_stale_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    const ack: RegisterAckFrame = {
      type: "register-ack",
      error: { code: "unknown_registration_token", message: "no such row" },
    };
    h.router(ack);

    // THE central invariant. unknown_registration_token must NOT suppress
    // auto-reconnect — the next attempt re-mints and recovers automatically.
    // If a refactor hoists markRejected() to all error branches (because
    // "name_taken does it, default does it, why not all?"), this fails.
    expect(h.reconnect.rejectedCount).toBe(0);

    // Local token cleared in-memory + onTokenCleared callback fired.
    expect(h.tokenRef.current).toBeUndefined();
    expect(h.tokenClearedCount).toBe(1);

    // Inspector identity reflects the clear so the operator sees what
    // happened (don't surface 'rejected' here — that's reserved for sticky
    // errors that need operator action).
    expect(h.inspector.identityCalls).toEqual([{ kind: "cleared" }]);

    // Warn-level log (not error) — this is a self-heal, not a fault.
    expect(h.log.warn).toHaveLength(1);
    expect(h.log.warn[0].msg).toContain("clearing local state");
    expect(h.log.error).toHaveLength(0);

    // Success-path side effects must NOT fire on an error ack.
    expect(h.reconnect.acceptedCount).toBe(0);
    expect(h.webhooks.setTunnelOpenCalls).toEqual([]);
    expect(h.webhooks.reallocateAllCount).toBe(0);
  });

  it("marks rejected on name_taken with operator-actionable message", () => {
    const h = buildHarness("tok_intact_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const ack: RegisterAckFrame = {
      type: "register-ack",
      error: { code: "name_taken", message: "another connector owns this name" },
    };
    h.router(ack);

    // Sticky — operator must intervene (delete the other row, or rename
    // this connector in the inspector's Configure Tunnel modal).
    expect(h.reconnect.rejectedCount).toBe(1);

    // Local token is preserved (we still own it; the name collision doesn't
    // invalidate our token). This is what makes operator recovery possible —
    // fix the name and we reconnect with the same token.
    expect(h.tokenRef.current).toBe("tok_intact_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(h.tokenClearedCount).toBe(0);

    // Identity surfaces the reason verbatim so the inspector can render it.
    expect(h.inspector.identityCalls).toHaveLength(1);
    const identity = h.inspector.identityCalls[0] as { kind: string; reason: string; message: string };
    expect(identity.kind).toBe("rejected");
    expect(identity.reason).toBe("name_taken");
    expect(identity.message).toContain("test-connector");

    // Error-level log (this is a fault that needs operator action).
    expect(h.log.error).toHaveLength(1);
    expect(h.log.error[0].msg).toContain("test-connector");
  });

  it("marks rejected on an unknown error code (fail-safe default for forward compat)", () => {
    const h = buildHarness();
    const ack: RegisterAckFrame = {
      type: "register-ack",
      error: { code: "future_controller_added_this", message: "tenant_disabled" },
    };
    h.router(ack);

    expect(h.reconnect.rejectedCount).toBe(1);
    expect(h.inspector.identityCalls).toHaveLength(1);
    const identity = h.inspector.identityCalls[0] as { kind: string; reason: string; message: string };
    expect(identity.kind).toBe("rejected");
    expect(identity.reason).toBe("future_controller_added_this");
    expect(identity.message).toBe("tenant_disabled");
  });
});

describe("frame-router non-register frame routing", () => {
  it("routes webhook-allocate-ack to onAllocateAck only", () => {
    const h = buildHarness();
    const frame: WebhookAllocateAckFrame = {
      type: "webhook-allocate-ack",
      mcp: "apis",
      url: "https://example.com/webhook/x/y",
    };
    h.router(frame);

    expect(h.webhooks.allocateAcks).toEqual([frame]);
    expect(h.webhooks.dispatched).toEqual([]);
    expect(h.reconnect.acceptedCount).toBe(0);
    expect(h.reconnect.rejectedCount).toBe(0);
    expect(h.inspector.identityCalls).toEqual([]);
  });

  it("routes webhook to dispatch only", () => {
    const h = buildHarness();
    const frame: WebhookFrame = {
      type: "webhook",
      mcp: "apis",
      queryParameters: {},
      body: { CallStatus: "completed" },
      receivedAt: 1700000000000,
    };
    h.router(frame);

    expect(h.webhooks.dispatched).toEqual([frame]);
    expect(h.webhooks.allocateAcks).toEqual([]);
    expect(h.reconnect.acceptedCount).toBe(0);
    expect(h.reconnect.rejectedCount).toBe(0);
  });

  it("ignores heartbeat / rpc / manifest-delta / goodbye frames silently", () => {
    const h = buildHarness();
    const frames = [
      { type: "heartbeat", ts: 1 } as HeartbeatFrame,
      { type: "rpc", payload: {} } as RpcFrame,
      { type: "manifest-delta", delta: { added: [], removed: [], changed: [] } } as ManifestDeltaFrame,
      { type: "goodbye", reason: "test" } as GoodbyeFrame,
    ];
    for (const frame of frames) h.router(frame);

    expect(h.webhooks.allocateAcks).toEqual([]);
    expect(h.webhooks.dispatched).toEqual([]);
    expect(h.webhooks.setTunnelOpenCalls).toEqual([]);
    expect(h.webhooks.reallocateAllCount).toBe(0);
    expect(h.reconnect.acceptedCount).toBe(0);
    expect(h.reconnect.rejectedCount).toBe(0);
    expect(h.inspector.identityCalls).toEqual([]);
    expect(h.log.info).toEqual([]);
    expect(h.log.warn).toEqual([]);
    expect(h.log.error).toEqual([]);
  });
});
