// Customer drop-in approval gate (W-A2 of MCP-CUSTOM-APPROVAL).
//
// A customer-authored drop-in MCP (folder under MCP_DROPIN_DIR; status.source
// === "local") is a *proposal*, not an *acceptance*. The connector spawns
// the child unconditionally (preserves crash isolation + the authoring
// loop), but withholds its tools from the manifest until an operator clicks
// Approve in the controller UI. The coordinator owns:
//
//   * The in-memory approved set (`Set<string>` of MCP folder names).
//   * `isApproved(name)` — read by buildManifest's gate predicate.
//   * `emitDiscovered(...)` — fired at boot for every drop-in not yet
//     approved, and for any drop-in added by a runtime rescan.
//   * `handleEnable(frame)` / `handleDisable(frame)` — operator gestures
//     and the post-register-ack replay path. Apply env via supervisor
//     (creds-update path), trigger a manifest rebuild, emit the ack.
//
// LIFETIME — read this before changing the construction site.
//
// Same shape as McpConfigCoordinator and LocalMcpsCoordinator. Constructed
// ONCE per connector process and outlives WS reconnects. The approved set
// is the connector's runtime gate — clearing it on reconnect would create
// a flicker where every drop-in's tools vanish from the manifest until the
// controller's `mcp-enable` replay completes. The controller is the durable
// authority for approval state (replays after every register-ack), but the
// connector's in-memory set IS the gate moment-to-moment.
//
// Per-tunnel rebind goes through bind({send}) — only the wire callback
// changes between tunnels. Approved set is deliberately preserved.
//
// See .claude/plans/MCP-CUSTOM-APPROVAL.md for the full plan + sequences,
// docs/MCP-PROTOCOL.md §"v1.3 — Customer drop-in approval gate" for the
// wire contract.

import type {
  McpDisableFrame,
  McpDiscoveredFrame,
  McpEnableAckFrame,
  McpEnableFrame,
  TunnelFrame,
} from "./frames.js";
import type { McpStatus, McpSupervisor } from "../mcp-supervisor.js";
import type { Logger } from "../logger.js";

// What a freshly-spawned drop-in surfaces — names + descriptions only,
// schemas deliberately withheld until approval per DA4. The boot path
// already has the connection / manifest data; this is just the projection
// the coordinator needs to author an `mcp-discovered` frame.
export interface DiscoveredMcpInfo {
  mcp: string;
  envKeys: string[];
  tools: Array<{ name: string; description?: string }>;
}

export interface ApprovalCoordinatorOpts {
  send: (frame: TunnelFrame) => void;
  supervisor: McpSupervisor;
  log: Logger;
  // Triggered after an enable/disable settles. The boot wiring's
  // `refreshManifestAndPushDelta` is the canonical implementation —
  // re-runs buildManifest (which now consults `isApproved`) and pushes a
  // manifest-delta IF the shape changed. Awaited so the ack is sent
  // strictly AFTER the delta, per the v1.3 frame-ordering rule.
  onManifestChange: () => void | Promise<void>;
}

export interface ApprovalCoordinatorBind {
  send: (frame: TunnelFrame) => void;
  log?: Logger;
}

export class ApprovalCoordinator {
  // The runtime gate. Names of drop-in MCPs the controller has marked
  // approved this session. Consulted by buildManifest via `isApproved`.
  // Survives WS reconnect by design (see LIFETIME comment above).
  private readonly approved = new Set<string>();

  // Wire-side hooks. Replaced via bind() on every tunnel reconnect.
  private send: (frame: TunnelFrame) => void;
  private log: Logger;

  constructor(private readonly opts: ApprovalCoordinatorOpts) {
    this.send = opts.send;
    this.log = opts.log;
  }

  // Per-tunnel rebind. Same contract as McpConfigCoordinator.bind: swap the
  // wire send callback so frames emitted by an in-flight handler reach the
  // current tunnel, not a closed one. The approved set is deliberately
  // preserved across reconnects.
  bind(b: ApprovalCoordinatorBind): void {
    this.send = b.send;
    if (b.log) this.log = b.log;
  }

  // Predicate consumed by buildManifest. A drop-in (status.source === "local"
  // && author === "customer") is omitted from the manifest unless this
  // returns true. Yaml-listed and controller-config entries are not gated —
  // buildManifest's caller never invokes this for those.
  isApproved(name: string): boolean {
    return this.approved.has(name);
  }

  // The single runtime gate every entry point consults: tunnel dispatch,
  // controller-call, and webhook delivery. `isApproved` answers "has the
  // controller approved this name"; this answers "may the controller reach
  // this MCP at all" — true for un-gated entries, the approval state for
  // gated ones. `isGated` is supplied by the boot wiring (today: "is a
  // drop-in"); widening the gate later edits only that predicate.
  isEnabled(name: string, isGated: (name: string) => boolean): boolean {
    return !isGated(name) || this.approved.has(name);
  }

  // Read-only snapshot for tests + inspector status panels. The coordinator's
  // private set is the single source of truth — never widen this to a write
  // accessor. Approval is mutated only via handleEnable/handleDisable.
  approvedSet(): ReadonlySet<string> {
    return this.approved;
  }

  // Author + emit `mcp-discovered`. The boot path calls this once per drop-in
  // that's NOT in the approved set after a register-ack; the L2 rescan path
  // calls it for freshly-added drop-in folders. Idempotent per call — the
  // controller treats redundant frames as a no-op (per DA3 the controller's
  // approval table is keyed on (connectorId, mcp)).
  emitDiscovered(info: DiscoveredMcpInfo): void {
    const frame: McpDiscoveredFrame = {
      type: "mcp-discovered",
      mcp: info.mcp,
      author: "customer",
      source: "local",
      envKeys: info.envKeys,
      tools: info.tools,
      // String-stamped at the call site rather than via Date.now() so the
      // frame is a flat-shaped value the supervisor / boot wiring can pass
      // through. ISO8601 UTC matches what the controller stores.
      discoveredAt: new Date().toISOString(),
    };
    this.send(frame);
    this.log.info(
      { mcp: info.mcp, envKeys: info.envKeys, toolCount: info.tools.length },
      `mcp-discovered emitted`,
    );
  }

  // Inbound `mcp-enable`. Two emission points on the controller side:
  //   1. operator approval click (initial or post-disable re-enable);
  //   2. post-register-ack replay for previously-approved MCPs.
  // Both forms route here. Idempotent — re-enabling an already-enabled
  // MCP is a no-op except for the ack frame.
  async handleEnable(frame: McpEnableFrame): Promise<void> {
    const status = this.lookupStatus(frame.mcp);
    if (!status) {
      this.sendAck({ type: "mcp-enable-ack", mcp: frame.mcp, status: "error", error: "unknown_mcp" });
      this.log.warn({ mcp: frame.mcp }, `mcp-enable for unknown MCP — replying unknown_mcp`);
      return;
    }
    const gateError = describeGateMismatch(status);
    if (gateError) {
      this.sendAck({ type: "mcp-enable-ack", mcp: frame.mcp, status: "error", error: gateError });
      this.log.warn({ mcp: frame.mcp, source: status.source }, `mcp-enable rejected — ${gateError}`);
      return;
    }

    const wasApproved = this.approved.has(frame.mcp);
    this.approved.add(frame.mcp);

    // applyControllerEnv triggers a child restart when `env` differs from
    // what we already have, which fires onRestart → refreshManifestAndPushDelta
    // (so a manifest-delta with the new tools precedes our ack). When env is
    // absent/empty we fall through to the explicit onManifestChange below so
    // a first-time approval still flips the descriptor into the manifest.
    if (frame.env) {
      try {
        await this.opts.supervisor.applyControllerEnv(
          frame.mcp,
          frame.env,
          // The wire frame's `source: "operator-entered"` maps verbatim to
          // the supervisor's CredsSource union — same path creds-update
          // takes today. `none` is what the supervisor uses for "no row,
          // fall back to dir/.env" — never appropriate here.
          "operator-entered",
          "mcp-enable",
        );
      } catch (err) {
        // Roll back the approved-set entry — the operator's view should
        // match what the connector actually exposes. Without rollback the
        // gate would say "approved" but the child wouldn't have the env
        // it needs to serve the tools.
        if (!wasApproved) this.approved.delete(frame.mcp);
        const reason = (err as Error).message;
        this.sendAck({
          type: "mcp-enable-ack",
          mcp: frame.mcp,
          status: "error",
          error: `apply_env_failed: ${reason}`,
        });
        this.log.error({ mcp: frame.mcp, err: err as Error }, `mcp-enable failed during applyControllerEnv`);
        return;
      }
    }

    // Idempotent re-enable: when nothing changed (already approved + no env
    // delta) the supervisor restart is skipped, no manifest-delta fires, and
    // we still want to ack. When this IS the first-time approval (or a
    // re-enable after a disable), the descriptor needs to reappear — call
    // onManifestChange explicitly. The hook is idempotent at the boot wiring
    // level (diffManifest produces an empty delta when nothing's new).
    try {
      await this.opts.onManifestChange();
    } catch (err) {
      this.log.error(
        { mcp: frame.mcp, err: err as Error },
        `mcp-enable: onManifestChange failed; ack will still fire`,
      );
    }

    const toolsCount = this.lookupStatus(frame.mcp)?.toolsCount ?? 0;
    this.sendAck({
      type: "mcp-enable-ack",
      mcp: frame.mcp,
      status: "enabled",
      toolsCount,
    });
    this.log.info(
      { mcp: frame.mcp, toolsCount, replay: wasApproved },
      `mcp-enable applied`,
    );
  }

  // Inbound `mcp-disable`. Per DA5: drop tools from the manifest only — do
  // NOT stop the child. Re-enable is sub-second.
  async handleDisable(frame: McpDisableFrame): Promise<void> {
    const status = this.lookupStatus(frame.mcp);
    if (!status) {
      this.sendAck({ type: "mcp-enable-ack", mcp: frame.mcp, status: "error", error: "unknown_mcp" });
      this.log.warn({ mcp: frame.mcp }, `mcp-disable for unknown MCP — replying unknown_mcp`);
      return;
    }
    const wasApproved = this.approved.delete(frame.mcp);
    if (wasApproved) {
      try {
        await this.opts.onManifestChange();
      } catch (err) {
        this.log.error(
          { mcp: frame.mcp, err: err as Error },
          `mcp-disable: onManifestChange failed; ack will still fire`,
        );
      }
    }
    this.sendAck({ type: "mcp-enable-ack", mcp: frame.mcp, status: "disabled" });
    this.log.info({ mcp: frame.mcp, wasApproved }, `mcp-disable applied`);
  }

  // ─── private ────────────────────────────────────────────────────────────

  private lookupStatus(name: string): McpStatus | undefined {
    return this.opts.supervisor.statusList().find((s) => s.name === name);
  }

  private sendAck(ack: McpEnableAckFrame): void {
    this.send(ack);
  }
}

// Predicate: is this MCP NOT eligible for the approval gate? Returns the
// human-readable reason string for the ack's `error` field, or undefined
// when the MCP is a customer drop-in (gate applies). Centralised so a
// future widening of the gate predicate touches one place.
function describeGateMismatch(status: McpStatus): string | undefined {
  if (status.source === "yaml") {
    return "not_gated: yaml-listed MCP, no approval needed";
  }
  if (status.source === "controller-config") {
    return "not_gated: 3rd-party MCP, use mcp-config-snapshot";
  }
  return undefined;
}
