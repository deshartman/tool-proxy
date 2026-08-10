// v1.4 — Controller API calls (Twilio-bundled only).
//
// A Twilio-authored bundled MCP's tool handler calls out to a named
// controller-side action and gets a typed result back, synchronously,
// before its own tool call returns. Modeled directly on CredsCoordinator
// (per-request `pending` Map keyed by requestId, resolved on the matching
// response frame, timer-based fallback) — see docs/MCP-PROTOCOL.md
// §"v1.4 — Controller API calls (Twilio-bundled only)" for the wire
// contract.
//
// Unlike CredsCoordinator / WebhookRegistry, this coordinator does NOT
// survive across reconnects as a stable outer binding — a fresh instance
// is constructed inside connectTunnelDb() on every dial (same lifetime as
// CredsCoordinator). A pending call whose tunnel drops mid-flight rejects
// immediately rather than resuming on the next reconnect: the customer's
// HTTP request behind it is still blocked waiting, so failing fast is
// correct — see onTunnelClose().

import { randomUUID } from "node:crypto";
import type { ControllerCallResponseFrame, TunnelFrame } from "./frames.js";
import type { Logger } from "../logger.js";

interface PendingCall {
  action: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ControllerApiCoordinatorOpts {
  send: (frame: TunnelFrame) => void;
  log: Logger;
  // Default per-call timeout in ms when the caller doesn't override.
  timeoutMs?: number;
}

export class ControllerApiCoordinator {
  private readonly pending = new Map<string, PendingCall>();
  private readonly defaultTimeoutMs: number;

  constructor(private readonly opts: ControllerApiCoordinatorOpts) {
    this.defaultTimeoutMs = opts.timeoutMs ?? 8000;
  }

  call(mcp: string, mcpId: string | undefined, action: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const requestId = randomUUID();
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`controller-call "${action}" timed out after ${effectiveTimeoutMs}ms`), { code: "timeout" }));
      }, effectiveTimeoutMs);
      this.pending.set(requestId, { action, resolve, reject, timer });
      this.opts.send({
        type: "controller-call",
        requestId,
        mcp,
        ...(mcpId ? { mcpId } : {}),
        action,
        params,
      });
    });
  }

  handleResponse(frame: ControllerCallResponseFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending) {
      this.opts.log.warn({ requestId: frame.requestId }, `controller-call-response with unknown requestId — dropping`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);
    if (frame.error) {
      pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
      return;
    }
    pending.resolve(frame.result);
  }

  // Called when the tunnel closes. A blocked customer-facing call should
  // fail fast, not silently resume on the next reconnect.
  onTunnelClose(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(`controller-call "${pending.action}" aborted: tunnel closed`), { code: "tunnel_closed" }));
      this.pending.delete(requestId);
    }
  }
}
