import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameRouter } from "../../src/tunnel/frame-router.js";
import type { FrameRouterOpts } from "../../src/tunnel/frame-router.js";
import type { ConnectorState } from "../../src/state.js";
import type {
  HeartbeatFrame,
  ManifestDeltaFrame,
  GoodbyeFrame,
  RegisterAckFrame,
  RpcFrame,
  WebhookAllocateAckFrame,
  WebhookFrame,
} from "../../src/tunnel/frames.js";

// Defensive tests for createFrameRouter. The behaviors pinned here are the
// ones we watched fire end-to-end in /tmp/connector-boot.log on 2026-06-18:
//   * unknown_registration_token self-heal (the heart of automatic recovery
//     from controller DB resets)
//   * register-ack success persists a freshly-minted token
// The asymmetry between the three error branches — only
// unknown_registration_token avoids markRejected() — is exactly the kind of
// invariant a "tidying" refactor erodes. Pin it.

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
  state: ConnectorState;
  statePath: string;
}

let tmpdirPath: string;

function buildHarness(initialState: ConnectorState = {}, opts?: { withInspector?: boolean }): Harness {
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
  const fakeLog = {
    info: (ctx: unknown, msg: string) => { log.info.push({ ctx, msg }); },
    warn: (ctx: unknown, msg: string) => { log.warn.push({ ctx, msg }); },
    error: (ctx: unknown, msg: string) => { log.error.push({ ctx, msg }); },
  };

  const state: ConnectorState = { ...initialState };
  const statePath = join(tmpdirPath, ".connector-state.json");

  const routerOpts: FrameRouterOpts = {
    webhooks: fakeWebhooks as unknown as FrameRouterOpts["webhooks"],
    state,
    statePath,
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
    state,
    statePath,
  };
}

beforeEach(() => {
  tmpdirPath = mkdtempSync(join(tmpdir(), "frame-router-test-"));
});

afterEach(() => {
  rmSync(tmpdirPath, { recursive: true, force: true });
});

describe("frame-router success path", () => {
  it("persists a freshly-minted token, resets reconnect, opens webhook delivery, and stamps inspector identity", () => {
    const h = buildHarness({ registrationToken: undefined });
    // 36 chars; matches the registrationToken length we observed in the boot
    // log on 2026-06-18.
    const tok = "tok_freshly_minted_xxxxxxxxxxxxxxxxx";
    expect(tok).toHaveLength(36);
    const ack: RegisterAckFrame = {
      type: "register-ack",
      accepted: true,
      connectorId: "conn_abc123",
      registrationToken: tok,
    };

    h.router(ack);

    // Reconnect curve resets, attempt counter cleared.
    expect(h.reconnect.acceptedCount).toBe(1);
    expect(h.reconnect.rejectedCount).toBe(0);

    // Webhook delivery opens AND queued allocates drain — both must fire,
    // in this order, or the apis-bundle's queued webhook-allocate from boot
    // never reaches the controller.
    expect(h.webhooks.setTunnelOpenCalls).toEqual([true]);
    expect(h.webhooks.reallocateAllCount).toBe(1);

    // Token persisted to disk, atomic-renamed into place.
    expect(h.state.registrationToken).toBe(tok);
    expect(existsSync(h.statePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(onDisk.registrationToken).toBe(tok);

    // Inspector header carries connectorId + lastRegisterAckAt timestamp.
    expect(h.inspector.identityCalls).toEqual([{ kind: "bound", tokenLen: 36 }]);
    expect(h.inspector.headerCalls).toHaveLength(1);
    const header = h.inspector.headerCalls[0] as Record<string, string>;
    expect(header.connectorId).toBe("conn_abc123");
    expect(header.lastRegisterAckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The persist log line fired (proves we took the write branch, not the
    // "bound to existing record" branch).
    expect(h.log.info.some((line) => line.msg.includes("persisted registrationToken"))).toBe(true);
  });

  it("does NOT rewrite the state file when the controller echoes back the same token", () => {
    const existing = "tok_already_persisted_36chars_xxxxxxxxxx";
    const h = buildHarness({ registrationToken: existing });
    const ack: RegisterAckFrame = {
      type: "register-ack",
      accepted: true,
      connectorId: "conn_xyz",
      registrationToken: existing,
    };

    h.router(ack);

    // The success bookkeeping fires regardless...
    expect(h.reconnect.acceptedCount).toBe(1);
    expect(h.webhooks.setTunnelOpenCalls).toEqual([true]);
    // ...but no state file should appear, because writeState was never called.
    // This is the disk-write guard at frame-router.ts:68 — refactoring it
    // away churns the volume on every reconnect.
    expect(existsSync(h.statePath)).toBe(false);

    // The "bound to existing record" log line fires instead of the persist line.
    expect(h.log.info.some((line) => line.msg.includes("bound to existing record"))).toBe(true);
    expect(h.log.info.some((line) => line.msg.includes("persisted registrationToken"))).toBe(false);
  });
});

describe("frame-router register-ack error sub-table", () => {
  it("self-heals on unknown_registration_token: clears state, removes file, does NOT mark rejected", () => {
    // Seed both in-memory state AND the state file so we can verify clear
    // really happens.
    const h = buildHarness({ registrationToken: "tok_stale_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    // Pre-create the file via the same atomic-rename code path so the test
    // mirrors a real boot. Easiest: use writeFileSync directly since we're
    // simulating the prior session's write.
    writeFileSync(h.statePath, JSON.stringify({ registrationToken: "tok_stale_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }));
    expect(existsSync(h.statePath)).toBe(true);

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

    // Local state cleared in-memory AND on disk.
    expect(h.state.registrationToken).toBeUndefined();
    expect(existsSync(h.statePath)).toBe(false);

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
    const h = buildHarness({ registrationToken: "tok_intact_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const ack: RegisterAckFrame = {
      type: "register-ack",
      error: { code: "name_taken", message: "another connector owns this name" },
    };
    h.router(ack);

    // Sticky — operator must intervene (delete the other row, or change
    // CONNECTOR_NAME).
    expect(h.reconnect.rejectedCount).toBe(1);

    // Local token is preserved (we still own it, the name collision doesn't
    // mean our token is invalid). This is what makes operator recovery
    // possible — they fix the name and we reconnect with the same token.
    expect(h.state.registrationToken).toBe("tok_intact_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

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

    // New controller error codes default to sticky. Rationale: an unknown
    // error is more likely a permission/policy fault than a transient one;
    // looping on it would mask the failure. This is fail-safe-not-fail-open.
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
    // Critical: must NOT have hit the register-ack branch (which would touch
    // state, reconnect, inspector). Frame-type misclassification here would
    // be a hard-to-diagnose corruption.
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

    // No side effects on any fake. These frames are handled by other parts
    // of the connector (heartbeat plumbing, dispatcher, manifest-delta sender)
    // — the router just lets them pass through.
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
