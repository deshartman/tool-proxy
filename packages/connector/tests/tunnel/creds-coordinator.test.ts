import { describe, it, expect, vi, beforeEach } from "vitest";

import { CredsCoordinator } from "../../src/tunnel/creds-coordinator.js";
import type { CredsResponseFrame, CredsUpdateFrame } from "../../src/tunnel/frames.js";
import type { McpSupervisor } from "../../src/mcp-supervisor.js";
import type { Logger } from "../../src/logger.js";

// Defensive tests for CredsCoordinator's error-isolation wrapper.
// The bug this pins (boot 2026-06-21): handleResponse / handleUpdate
// called `void this.applyEnv(...)` with no .catch, so a supervisor
// restart that threw became an unhandled promise rejection and crashed
// the connector process. Multiple in-flight applies could each crash
// the connector. The fix is applyEnvSafely() — same fire-and-forget
// shape, but with a logged catch that contains the failure to one MCP.
//
// We avoid touching a real supervisor: the coordinator's contract with
// the supervisor is one method (applyControllerEnv), so a fake suffices.

interface FakeLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function fakeLogger(): FakeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function buildCoordinator(opts: {
  applyControllerEnv: (
    mcp: string,
    env: Record<string, string>,
    source: "twilio-tunnel-row" | "operator-entered" | "none",
    reason?: string,
  ) => Promise<{ applied: boolean; restarted: boolean }>;
}): { coordinator: CredsCoordinator; log: FakeLogger; sent: unknown[] } {
  const log = fakeLogger();
  const sent: unknown[] = [];
  const supervisor = {
    applyControllerEnv: opts.applyControllerEnv,
  } as unknown as McpSupervisor;
  const coordinator = new CredsCoordinator({
    send: (frame) => sent.push(frame),
    supervisor,
    log: log as unknown as Logger,
    softWaitMs: 100,
  });
  return { coordinator, log, sent };
}

// Wait for any pending microtasks/macrotasks to drain so a fire-and-forget
// `.catch(...)` chain has a chance to run. Two awaits cover Promise
// resolutions that hop through one extra microtask boundary.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CredsCoordinator error isolation", () => {
  let unhandledRejections: unknown[] = [];

  beforeEach(() => {
    unhandledRejections = [];
    // Surface unhandled rejections as test failures. If the catch wrapper
    // is removed, these listeners catch the leaked rejection and the
    // assertion below fails. (Vitest 4 also surfaces them, but explicit
    // capture is clearer in the failure message.)
    process.on("unhandledRejection", (reason) => {
      unhandledRejections.push(reason);
    });
  });

  it("does not leak an unhandled rejection when supervisor.applyControllerEnv throws on a creds-response", async () => {
    const { coordinator, log } = buildCoordinator({
      applyControllerEnv: () => Promise.reject(new Error("respawn failed: ECONNREFUSED 127.0.0.1:7100")),
    });

    // Plant a pending request matching the response we're about to feed.
    // We piggy-back on the public reload() which sends a creds-request
    // (we don't care about the wire side, just that there's a pending
    // entry to match). Then craft a response frame with that requestId.
    const reload = coordinator.reload("sample", "customer", []);
    // The reload() promise resolves on response or after softWaitMs+1000.
    // We don't await it — instead, dig the requestId out from sent
    // frames by exposing it through the send capture.

    // Pull requestId from the frame we just sent.
    const sentFrame = (coordinator as unknown as { pending: Map<string, { mcp: string }> }).pending;
    const requestId = [...sentFrame.keys()][0];
    expect(requestId).toBeTruthy();

    const response: CredsResponseFrame = {
      type: "creds-response",
      requestId,
      env: { TWILIO_AUTH_TOKEN: "new" },
      source: "operator-entered",
    };
    coordinator.handleResponse(response);

    await flush();
    await flush();

    // The error path was hit, but it was isolated to a log call —
    // the process did NOT see an unhandledRejection.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ mcp: "sample", reason: "creds-response" }),
      expect.stringContaining("creds apply failed"),
    );
    expect(unhandledRejections).toEqual([]);

    // Reload's promise still resolves (the per-request resolver fires
    // before applyEnvSafely runs).
    await reload;
  });

  it("does not leak an unhandled rejection when supervisor.applyControllerEnv throws on a creds-update push", async () => {
    const { coordinator, log } = buildCoordinator({
      applyControllerEnv: () => Promise.reject(new Error("supervisor respawn failed")),
    });

    const update: CredsUpdateFrame = {
      type: "creds-update",
      mcp: "apis",
      env: { TWILIO_AUTH_TOKEN: "rotated" },
      source: "twilio-tunnel-row",
      reason: "AccountSid rotated",
    };
    coordinator.handleUpdate(update);

    await flush();
    await flush();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ mcp: "apis", reason: "AccountSid rotated" }),
      expect.stringContaining("creds apply failed"),
    );
    expect(unhandledRejections).toEqual([]);
  });

  it("logs the buffered/no-restart message when supervisor.applyControllerEnv resolves with restarted=false (the empty-payload no-op path)", async () => {
    const apply = vi.fn().mockResolvedValue({ applied: true, restarted: false });
    const { coordinator, log } = buildCoordinator({ applyControllerEnv: apply });

    const reload = coordinator.reload("sample", "customer", []);
    const requestId = [
      ...(coordinator as unknown as { pending: Map<string, { mcp: string }> }).pending.keys(),
    ][0];

    coordinator.handleResponse({
      type: "creds-response",
      requestId,
      env: {},
      source: "none",
    });

    await flush();
    await flush();

    expect(apply).toHaveBeenCalledWith("sample", {}, "none", "creds-response");
    // Log emitted via applyEnv — proves the success branch ran.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ mcp: "sample", source: "none", keys: [] }),
      expect.stringContaining("buffered"),
    );
    expect(log.error).not.toHaveBeenCalled();
    await reload;
  });
});

// ──────────────────────────────────────────────────────────────────────
// Defensive tests for the empty-string strip at the wire boundary.
//
// docs/MCP-PROTOCOL.md §"creds-response — controller MUST omit absent
// keys" specifies the contract. The connector's stripEmptyValues helper
// is the defensive backstop: a controller that violates the contract
// (sends `{X: ""}` when omitting was intended) MUST NOT cause restart
// churn or crash the connector. The supervisor's envEquals no-op-skip
// guard (commit 0900b8c) treats `{}` and `{X: ""}` as different
// payloads — without this strip, the same "no SendGrid creds" reply
// would thrash the apis child every time it arrived.
//
// Three creds shapes that must all converge to the same supervisor
// payload when controllers are inconsistent:
//   1. Controller omits the absent key:           env: { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN }
//   2. Controller sends empty string for absent:  env: { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY: "" }
//   3. Controller sends entirely empty payload:   env: {}
//
// All three should reach supervisor.applyControllerEnv with values that
// produce identical behaviour — no empty-string keys leak through.
// ──────────────────────────────────────────────────────────────────────
describe("CredsCoordinator strips empty-string values from controller-supplied env", () => {
  it("creds-response: drops empty-string keys before reaching the supervisor", async () => {
    const apply = vi.fn().mockResolvedValue({ applied: true, restarted: false });
    const { coordinator } = buildCoordinator({ applyControllerEnv: apply });

    const reload = coordinator.reload("apis", "twilio", []);
    const requestId = [
      ...(coordinator as unknown as { pending: Map<string, { mcp: string }> }).pending.keys(),
    ][0];

    coordinator.handleResponse({
      type: "creds-response",
      requestId,
      env: {
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "tok",
        SENDGRID_API_KEY: "",
      },
      source: "twilio-tunnel-row",
    });

    await flush();
    await flush();

    // Only the two non-empty keys reach the supervisor.
    expect(apply).toHaveBeenCalledWith(
      "apis",
      { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" },
      "twilio-tunnel-row",
      "creds-response",
    );
    await reload;
  });

  it("creds-update: same strip applies on the controller-push path", async () => {
    const apply = vi.fn().mockResolvedValue({ applied: true, restarted: true });
    const { coordinator } = buildCoordinator({ applyControllerEnv: apply });

    coordinator.handleUpdate({
      type: "creds-update",
      mcp: "apis",
      env: {
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "tok",
        SENDGRID_API_KEY: "",
        EMPTY_OPTIONAL: "",
      },
      source: "twilio-tunnel-row",
      reason: "rotation",
    });

    await flush();
    await flush();

    expect(apply).toHaveBeenCalledWith(
      "apis",
      { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" },
      "twilio-tunnel-row",
      "rotation",
    );
  });

  it("convergence: all three controller shapes for 'no SendGrid' produce identical supervisor payloads", async () => {
    // The contract claim from MCP-PROTOCOL.md: a controller that has no
    // SendGrid for an org can express that three ways. The connector
    // MUST treat all three as equivalent so envEquals doesn't see a
    // difference and trigger a pointless restart.
    const calls: Array<Record<string, string>> = [];
    const apply = vi.fn().mockImplementation(
      (_mcp: string, env: Record<string, string>) => {
        calls.push(env);
        return Promise.resolve({ applied: true, restarted: false });
      },
    );
    const { coordinator } = buildCoordinator({ applyControllerEnv: apply });

    const shapes: Array<Record<string, string>> = [
      // Shape 1: omitted absent key (the spec-correct shape)
      { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" },
      // Shape 2: empty-string absent key (controller bug — defensive backstop)
      { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", SENDGRID_API_KEY: "" },
      // Shape 3: even more keys empty
      { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", SENDGRID_API_KEY: "", FUTURE_KEY: "" },
    ];

    for (const env of shapes) {
      coordinator.handleUpdate({
        type: "creds-update",
        mcp: "apis",
        env,
        source: "twilio-tunnel-row",
      });
      await flush();
      await flush();
    }

    expect(calls).toHaveLength(3);
    // Every call delivered the same payload to the supervisor.
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual(calls[2]);
    expect(calls[0]).toEqual({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" });
  });

  it("preserves real values that contain whitespace or special characters", async () => {
    // Strip is empty-string-only, NOT a generic falsy filter. A real
    // value of "  " (whitespace) or "0" or "false" must reach the
    // supervisor untouched.
    const apply = vi.fn().mockResolvedValue({ applied: true, restarted: false });
    const { coordinator } = buildCoordinator({ applyControllerEnv: apply });

    coordinator.handleUpdate({
      type: "creds-update",
      mcp: "apis",
      env: {
        REAL_VALUE: "AC123",
        WHITESPACE: "   ",
        ZERO: "0",
        FALSE: "false",
        EMPTY_TO_DROP: "",
      },
      source: "operator-entered",
    });

    await flush();
    await flush();

    expect(apply).toHaveBeenCalledWith(
      "apis",
      { REAL_VALUE: "AC123", WHITESPACE: "   ", ZERO: "0", FALSE: "false" },
      "operator-entered",
      "creds-update",
    );
  });

  it("does not crash on undefined env in creds-response (reply with only an error field)", async () => {
    const apply = vi.fn().mockResolvedValue({ applied: true, restarted: false });
    const { coordinator, log } = buildCoordinator({ applyControllerEnv: apply });

    const reload = coordinator.reload("apis", "twilio", []);
    const requestId = [
      ...(coordinator as unknown as { pending: Map<string, { mcp: string }> }).pending.keys(),
    ][0];

    // env field omitted entirely — the existing `?? {}` fallback handles
    // it, then stripEmptyValues runs on the empty default.
    coordinator.handleResponse({
      type: "creds-response",
      requestId,
      source: "none",
    });

    await flush();
    await flush();

    expect(apply).toHaveBeenCalledWith("apis", {}, "none", "creds-response");
    expect(log.error).not.toHaveBeenCalled();
    await reload;
  });
});
