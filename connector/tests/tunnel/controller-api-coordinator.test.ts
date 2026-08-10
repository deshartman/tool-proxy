import { describe, it, expect, beforeEach } from "vitest";

import { ControllerApiCoordinator } from "../../src/tunnel/controller-api-coordinator.js";
import type { ControllerCallResponseFrame, TunnelFrame } from "../../src/tunnel/frames.js";
import type { Logger } from "../../src/logger.js";

// v1.4 — Controller API calls. Mirrors creds-coordinator.test.ts's
// conventions: fake logger, `send` captured into an array, real short
// timeoutMs (no fake timers), and an explicit unhandledRejection listener
// so a coordinator bug that leaks a rejected promise fails the test instead
// of crashing the connector process silently.

function fakeLogger(): { info: () => void; warn: (...args: unknown[]) => void; error: () => void; warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  return {
    info: () => {},
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    error: () => {},
    warnCalls,
  };
}

function buildCoordinator(opts: { timeoutMs?: number } = {}): {
  coordinator: ControllerApiCoordinator;
  log: ReturnType<typeof fakeLogger>;
  sent: TunnelFrame[];
} {
  const log = fakeLogger();
  const sent: TunnelFrame[] = [];
  const coordinator = new ControllerApiCoordinator({
    send: (frame) => sent.push(frame),
    log: log as unknown as Logger,
    timeoutMs: opts.timeoutMs,
  });
  return { coordinator, log, sent };
}

describe("ControllerApiCoordinator", () => {
  let unhandledRejections: unknown[] = [];

  beforeEach(() => {
    unhandledRejections = [];
    process.on("unhandledRejection", (reason) => {
      unhandledRejections.push(reason);
    });
  });

  it("resolves with the response's result when a matching controller-call-response arrives", async () => {
    const { coordinator, sent } = buildCoordinator();
    const promise = coordinator.call("agentic-memory", undefined, "memory.append_event", { customerId: "CU123" });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as { type: string; requestId: string; mcp: string; mcpId?: string; action: string; params: unknown };
    expect(frame.type).toBe("controller-call");
    expect(frame.mcp).toBe("agentic-memory");
    expect(frame.mcpId).toBeUndefined();
    expect(frame.action).toBe("memory.append_event");
    expect(frame.params).toEqual({ customerId: "CU123" });

    const response: ControllerCallResponseFrame = {
      type: "controller-call-response",
      requestId: frame.requestId,
      result: { eventId: "evt_789" },
    };
    coordinator.handleResponse(response);

    await expect(promise).resolves.toEqual({ eventId: "evt_789" });
    expect(unhandledRejections).toEqual([]);
  });

  it("includes mcpId on the frame when supplied", async () => {
    const { coordinator, sent } = buildCoordinator();
    const promise = coordinator.call("twilio-mcp", "mcp_abc123", "outbound.place_call", {});
    const frame = sent[0] as { requestId: string; mcpId?: string };
    expect(frame.mcpId).toBe("mcp_abc123");

    // Close out the pending call so its timer doesn't outlive the test.
    coordinator.handleResponse({ type: "controller-call-response", requestId: frame.requestId, result: {} });
    await promise;
  });

  it("rejects with the response's error when the controller reports a failure", async () => {
    const { coordinator, sent } = buildCoordinator();
    const promise = coordinator.call("agentic-memory", undefined, "memory.append_event", {});
    const requestId = (sent[0] as { requestId: string }).requestId;

    coordinator.handleResponse({
      type: "controller-call-response",
      requestId,
      error: { code: "unknown_action", message: "no handler registered for memory.append_event" },
    });

    await expect(promise).rejects.toMatchObject({
      message: "no handler registered for memory.append_event",
      code: "unknown_action",
    });
    expect(unhandledRejections).toEqual([]);
  });

  it("rejects with a timeout error when no response arrives within timeoutMs", async () => {
    const { coordinator } = buildCoordinator({ timeoutMs: 30 });
    const promise = coordinator.call("agentic-memory", undefined, "outbound.place_call", {});

    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(unhandledRejections).toEqual([]);
  });

  it("a per-call timeoutMs argument overrides the coordinator default", async () => {
    const { coordinator } = buildCoordinator({ timeoutMs: 5000 });
    const promise = coordinator.call("agentic-memory", undefined, "outbound.place_call", {}, 30);

    await expect(promise).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects every pending call on tunnel close instead of leaving them to time out", async () => {
    const { coordinator } = buildCoordinator({ timeoutMs: 5000 });
    const p1 = coordinator.call("agentic-memory", undefined, "memory.append_event", {});
    const p2 = coordinator.call("agentic-memory", undefined, "outbound.place_call", {});

    coordinator.onTunnelClose();

    await expect(p1).rejects.toMatchObject({ code: "tunnel_closed" });
    await expect(p2).rejects.toMatchObject({ code: "tunnel_closed" });
    expect(unhandledRejections).toEqual([]);
  });

  it("drops a controller-call-response with an unknown requestId instead of throwing", () => {
    const { coordinator, log } = buildCoordinator();

    expect(() => coordinator.handleResponse({
      type: "controller-call-response",
      requestId: "does-not-exist",
      result: {},
    })).not.toThrow();

    expect(log.warnCalls.length).toBeGreaterThan(0);
  });
});
