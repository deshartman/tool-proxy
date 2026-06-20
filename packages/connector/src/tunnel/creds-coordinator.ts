// Per-MCP credential exchange (W-C2 / W-C3 of MCP-LOADING).
//
// After register-ack, the boot wiring kicks one creds-request per MCP into
// the tunnel. The controller replies with a creds-response (env values for
// that MCP, or empty if it has no row yet). Late responses, controller
// pushes via creds-update, and inspector "Reload creds" clicks all flow
// through the same merge → supervisor.applyControllerEnv path.
//
// See docs/MCP-PROTOCOL.md for the wire format.

import { randomUUID } from "node:crypto";
import type {
  CredsRequestFrame,
  CredsResponseFrame,
  CredsUpdateFrame,
  TunnelFrame,
} from "./frames.js";
import type { McpSupervisor } from "../mcp-supervisor.js";
import type { Logger } from "../logger.js";

interface PendingRequest {
  mcp: string;
  resolve: (env: Record<string, string>, source: "twilio-tunnel-row" | "operator-entered" | "none") => void;
  timer?: NodeJS.Timeout;
}

export interface CredsCoordinatorOpts {
  send: (frame: TunnelFrame) => void;
  supervisor: McpSupervisor;
  log: Logger;
  // Soft-wait duration in ms. Boot stalls up to this long for responses
  // before continuing the spawn pipeline. Late responses still apply via
  // supervisor restart.
  softWaitMs?: number;
}

export class CredsCoordinator {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly softWaitMs: number;

  constructor(private readonly opts: CredsCoordinatorOpts) {
    this.softWaitMs = opts.softWaitMs ?? 5000;
  }

  // Send creds-request for every name; resolve when each response arrives or
  // the soft-wait elapses (whichever first). The returned map covers every
  // mcp passed in — entries that timed out have an empty env.
  async requestAllAtBoot(
    requests: Array<{ mcp: string; author: string; envKeys: string[] }>,
  ): Promise<void> {
    const promises = requests.map((req) => this.sendRequest(req));
    const timeout = new Promise<void>((res) => setTimeout(res, this.softWaitMs));
    await Promise.race([Promise.all(promises), timeout]);
    // Surface any still-pending requests as a single warn line so the
    // operator can see which MCPs fell back to dir/.env.
    const stillPending = [...this.pending.values()].map((p) => p.mcp);
    if (stillPending.length > 0) {
      this.opts.log.warn(
        { mcps: stillPending },
        `creds-request soft-wait elapsed — falling back to dir/.env for these MCPs`,
      );
    }
    // Don't drop the still-pending entries — late responses re-enter the
    // map via handleResponse and trigger a supervisor restart with the new
    // env. (Same code path as a creds-update push.)
  }

  // Fire a single creds-request for an MCP that's already running (e.g. the
  // inspector "Reload creds" affordance). Resolves when the response lands.
  async reload(name: string, author: string, envKeys: string[]): Promise<void> {
    await this.sendRequest({ mcp: name, author, envKeys });
  }

  handleResponse(frame: CredsResponseFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending) {
      this.opts.log.warn({ requestId: frame.requestId }, `creds-response with unknown requestId — dropping`);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);
    if (frame.error) {
      this.opts.log.warn({ mcp: pending.mcp, error: frame.error }, `creds-response error — falling back to dir/.env`);
      pending.resolve({}, "none");
      return;
    }
    const env = frame.env ?? {};
    const source = frame.source ?? "none";
    pending.resolve(env, source);
    this.applyEnvSafely(pending.mcp, env, source, "creds-response");
  }

  handleUpdate(frame: CredsUpdateFrame): void {
    this.applyEnvSafely(frame.mcp, frame.env, frame.source, frame.reason ?? "creds-update");
  }

  // Fire-and-forget wrapper. A supervisor restart that throws (e.g. child
  // fails to come back up on a creds-driven respawn) MUST NOT become an
  // unhandled rejection that crashes the connector — log it and move on.
  // The MCP stays in its stopped/failed state; the inspector status panel
  // surfaces the failure for the operator.
  private applyEnvSafely(
    mcp: string,
    env: Record<string, string>,
    source: "twilio-tunnel-row" | "operator-entered" | "none",
    reason: string,
  ): void {
    this.applyEnv(mcp, env, source, reason).catch((err) => {
      this.opts.log.error(
        { mcp, reason, err: err as Error },
        `creds apply failed — MCP may be in a degraded state`,
      );
    });
  }

  private async applyEnv(
    mcp: string,
    env: Record<string, string>,
    source: "twilio-tunnel-row" | "operator-entered" | "none",
    reason: string,
  ): Promise<void> {
    const result = await this.opts.supervisor.applyControllerEnv(mcp, env, source, reason);
    if (!result.applied) {
      this.opts.log.warn({ mcp }, `creds for unknown MCP — ignoring`);
      return;
    }
    if (result.restarted) {
      this.opts.log.info(
        { mcp, source, reason, keys: Object.keys(env) },
        `mcp creds_version_changed restart=true`,
      );
    } else {
      this.opts.log.info(
        { mcp, source, keys: Object.keys(env) },
        `mcp creds buffered — will apply on first spawn`,
      );
    }
  }

  private sendRequest(req: { mcp: string; author: string; envKeys: string[] }): Promise<void> {
    const requestId = randomUUID();
    const frame: CredsRequestFrame = {
      type: "creds-request",
      requestId,
      mcp: req.mcp,
      author: req.author,
      envKeys: req.envKeys,
    };
    this.opts.send(frame);
    return new Promise<void>((resolve) => {
      const pending: PendingRequest = {
        mcp: req.mcp,
        resolve: () => resolve(),
      };
      // Per-request timer is the safety valve in case the per-call
      // soft-wait race somehow misses a still-pending entry. Same effect
      // as the soft-wait expiring: resolve the promise so the boot pipeline
      // can move on.
      pending.timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve();
        }
      }, this.softWaitMs + 1000);
      this.pending.set(requestId, pending);
    });
  }
}
