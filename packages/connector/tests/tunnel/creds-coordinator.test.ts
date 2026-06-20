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
