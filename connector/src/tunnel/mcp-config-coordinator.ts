// Controller-driven 3rd-party MCP roster (W-E2 of MCP-LOADING).
//
// The controller's "New 3rd Party MCP" UI mints an entry per MCP and pushes
// the roster down via mcp-config-snapshot (full roster on register-ack and
// on resync) + mcp-config-delta (steady-state CRUD). This coordinator:
//
//   * Tracks lastAppliedGeneration in memory (no persistence on the connector).
//   * Translates McpConfigEntry → SupervisedSpec.
//   * Reconciles snapshots by diff against the running supervisor entries.
//   * Applies deltas (added / updated / removed) — gap detection triggers
//     mcp-config-resync; duplicates are dropped.
//   * Emits mcp-config-ack with per-MCP { mcpId, name, status, error? }.
//
// The yaml is NOT rewritten. Yaml-listed bundled / customer-authored MCPs
// and controller-supplied 3rd-party MCPs share the supervisor's entry map
// keyed by name. Yaml entries register first (boot path); controller entries
// register here. Name collision → ack with status:"failed" + error, no spawn.
//
// See docs/MCP-PROTOCOL.md §"v1.1 — 3rd-party MCP roster (controller-driven)".

import type {
  McpConfigAckFrame,
  McpConfigDeltaFrame,
  McpConfigEntry,
  McpConfigResyncFrame,
  McpConfigSnapshotFrame,
  TunnelFrame,
} from "./frames.js";
import type { McpServerSpec } from "../config.js";
import type { McpSupervisor, SupervisedSpec } from "../mcp-supervisor.js";
import type { Logger } from "../logger.js";

export interface McpConfigCoordinatorOpts {
  send: (frame: TunnelFrame) => void;
  supervisor: McpSupervisor;
  log: Logger;
  // Snapshot soft-wait. If no snapshot arrives within this window after
  // register-ack, the coordinator emits mcp-config-resync { reason: "boot" }
  // so an older controller surfaces explicitly rather than silently
  // running with an empty 3rd-party roster.
  snapshotWaitMs?: number;
}

// Per-tunnel rebind shape. Only the wire-side hooks change between tunnels —
// `supervisor` is process-wide and supplied at construction.
//
// `requestCreds` is wired to the per-tunnel CredsCoordinator so addEntry can
// fetch env values from the controller BEFORE the supervisor spawns the child.
// Without this pre-spawn fetch, controller-config 3rd-party MCPs (e.g. our
// standalone @deshartman/twilio-mcp added via the "New 3rd Party MCP" UI)
// boot with an empty process.env, register zero tools, and either crash the
// connector's discovery probe (-32601 from an empty tools/list) or sit Live
// with 0 tools until an operator clicks "Reload creds" by hand. Symmetric
// with the boot-time creds fan-out for yaml + drop-in entries; both paths
// MUST converge on "env present at spawn time" so children boot once.
//
// Awaiting the callback is the load-bearing part — `creds.reload` resolves
// only after the creds-response lands (or its 6s soft-wait elapses). By the
// time addEntry calls `supervisor.startOne`, applyControllerEnv has already
// populated `controllerEnv` so the spawn's merged env contains the creds.
export interface McpConfigCoordinatorBind {
  send: (frame: TunnelFrame) => void;
  log?: Logger;
  // Resolves when the controller has replied with creds-response (or the
  // soft-wait elapsed). The supervisor's controllerEnv is populated by the
  // response handler before this promise settles, so a startOne() immediately
  // after returns will spawn the child with the env in place.
  requestCreds?: (name: string, mcpId: string, envKeys: string[]) => Promise<void>;
}

interface RosterEntry {
  mcpId: string;
  name: string;
  // The full McpConfigEntry as supplied by the controller — kept verbatim
  // so updates can diff against the prior shape and re-derive the spec.
  config: McpConfigEntry;
}

// LIFETIME — read this before changing the construction site.
//
// The coordinator is constructed ONCE per connector process and outlives WS
// reconnects. Its `roster` and `nameToMcpId` maps are the connector's view of
// "which supervisor entries did I register from controller-config snapshots /
// deltas". That view tracks the supervisor (which also outlives reconnects)
// and MUST NOT blink when the WS does.
//
// Rebuilding the coordinator per-tunnel was the original shape (matched
// CredsCoordinator) but produced a real bug observed 2026-06-21: after a WS
// reconnect, an arriving `gen=N` snapshot containing only a freshly-added
// row would mis-identify the prior tunnel session's still-running supervisor
// entry as a yaml-clash (because the new coordinator's nameToMcpId was
// empty). The "Removed" loop also no-op'd, leaking the prior entry forever.
//
// Per-tunnel reset goes through bind() — see below — which only swaps the
// wire `send` callback and cancels any in-flight snapshot-wait timer. Steady
// state (the roster + lastAppliedGeneration) survives by design.
//
// Why CredsCoordinator's per-tunnel construction is correct and this isn't:
// CredsCoordinator tracks `pending: Map<requestId, …>` — pending IPC. A reply
// from a stale tunnel landing on a fresh one would be wrong, so its per-
// tunnel rebuild is a feature. The roster coordinator's `roster: Map<mcpId,
// …>` is the opposite — it's steady-state membership, not pending IPC.
export class McpConfigCoordinator {
  // mcpId → roster entry. Snapshot reconciliation uses this as the prior
  // state; delta operations mutate it in place. Survives WS reconnect.
  private readonly roster = new Map<string, RosterEntry>();
  // name → mcpId. Lets us go from supervisor entry → roster entry on
  // creds frames. Survives WS reconnect.
  private readonly nameToMcpId = new Map<string, string>();
  // Monotonic generation high-watermark. Survives WS reconnect.
  private lastAppliedGeneration = -1;
  // Wire-side hooks. Replaced via bind() on every tunnel reconnect.
  private send: (frame: TunnelFrame) => void;
  private log: Logger;
  // Per-tunnel creds fetch. Bound (and rebound) via bind(); a no-op until the
  // first bind so addEntry runs sanely in unit tests that don't wire creds.
  private requestCreds: (name: string, mcpId: string, envKeys: string[]) => Promise<void>;
  // Snapshot-wait timer. Cancelled on bind() so a timer armed for tunnel
  // N can't fire on tunnel N+1.
  private readonly snapshotWaitMs: number;
  private snapshotWaitTimer?: NodeJS.Timeout;

  constructor(private readonly opts: McpConfigCoordinatorOpts) {
    this.snapshotWaitMs = opts.snapshotWaitMs ?? 5000;
    this.send = opts.send;
    this.log = opts.log;
    // No-op until bind() supplies a real fetcher. addEntry treats a missing
    // creds-response as "no row yet — spawn anyway and rely on dir/.env",
    // matching the boot fan-out's soft-wait fallback. Unit tests that don't
    // wire creds get the same behaviour without needing to stub a callback.
    this.requestCreds = async () => undefined;
  }

  // Per-tunnel rebind. Called from the boot pipeline whenever a fresh tunnel
  // opens (after `tunnel = pendingTunnel`). Swaps the wire `send` so frames
  // emitted by an in-flight reconcile reach the new tunnel, NOT the closed
  // one. Cancels the prior tunnel's snapshot-wait timer for the same reason.
  // Roster + lastAppliedGeneration are deliberately preserved.
  bind(b: McpConfigCoordinatorBind): void {
    this.cancelSnapshotWait();
    this.send = b.send;
    if (b.log) this.log = b.log;
    // requestCreds is rebound for the same reason `send` is: the per-tunnel
    // CredsCoordinator's `pending` Map is tunnel-scoped, so a callback that
    // captured a stale tunnel's coordinator would route the response into a
    // dead Map. Bind() refreshes the closure to the live coordinator.
    if (b.requestCreds) this.requestCreds = b.requestCreds;
  }

  // Called from the boot pipeline right after register-ack. Arms a timer
  // that triggers `mcp-config-resync { reason: "boot" }` if no snapshot
  // lands within the window — guards against an older controller silently
  // leaving the 3rd-party roster empty.
  //
  // Re-armable across reconnects. The "boot" reason is the wire contract;
  // the timer just means "no snapshot since the last register-ack".
  armSnapshotWait(): void {
    this.cancelSnapshotWait();
    this.snapshotWaitTimer = setTimeout(() => {
      if (this.lastAppliedGeneration === -1) {
        this.log.warn(
          {},
          `mcp-config-snapshot soft-wait elapsed — sending mcp-config-resync. older controller? running with empty 3rd-party roster.`,
        );
        this.requestResync("boot");
      }
    }, this.snapshotWaitMs);
  }

  // Lookup the mcpId for a roster-sourced MCP by name. Used when building
  // creds-request frames so the controller can scope by (connectorId, mcpId).
  // Returns undefined for yaml-listed MCPs.
  mcpIdFor(name: string): string | undefined {
    return this.nameToMcpId.get(name);
  }

  async handleSnapshot(frame: McpConfigSnapshotFrame): Promise<void> {
    this.cancelSnapshotWait();
    if (frame.generation === this.lastAppliedGeneration) {
      // Expected on WS reconnect: controller redelivers the current
      // snapshot with an unchanged generation. Not a warning — the
      // no-op is by design.
      this.log.debug(
        { generation: frame.generation },
        `mcp-config-snapshot redelivered (same generation) — no-op`,
      );
      return;
    }
    if (frame.generation < this.lastAppliedGeneration) {
      // Genuinely stale — a newer snapshot already landed. Rare (would
      // require the controller to re-issue an older generation), but the
      // WARN is worth keeping so it surfaces if it ever does happen.
      this.log.warn(
        { generation: frame.generation, lastApplied: this.lastAppliedGeneration },
        `mcp-config-snapshot older than lastApplied — dropping`,
      );
      return;
    }
    this.log.info(
      { generation: frame.generation, count: frame.servers.length },
      `applying mcp-config-snapshot`,
    );

    const incoming = new Map<string, McpConfigEntry>();
    for (const entry of frame.servers) incoming.set(entry.mcpId, entry);

    const perMcp: McpConfigAckFrame["perMcp"] = [];

    // Removed: present in roster but not in snapshot.
    for (const [mcpId, prior] of this.roster) {
      if (!incoming.has(mcpId)) {
        const result = await this.removeEntry(prior);
        perMcp.push({ mcpId, name: prior.name, status: result.status, error: result.error });
      }
    }

    // Added or updated: present in snapshot.
    for (const [mcpId, next] of incoming) {
      const prior = this.roster.get(mcpId);
      if (!prior) {
        const result = await this.addEntry(next);
        perMcp.push({ mcpId, name: next.name, status: result.status, error: result.error });
      } else if (configEntryEquals(prior.config, next)) {
        // No-op — entry unchanged. Don't restart.
        perMcp.push({ mcpId, name: next.name, status: "started" });
      } else {
        const result = await this.updateEntry(prior, next);
        perMcp.push({ mcpId, name: next.name, status: result.status, error: result.error });
      }
    }

    this.lastAppliedGeneration = frame.generation;
    this.sendAck(frame.generation, perMcp);
  }

  async handleDelta(frame: McpConfigDeltaFrame): Promise<void> {
    if (frame.generation <= this.lastAppliedGeneration) {
      this.log.warn(
        { generation: frame.generation, lastApplied: this.lastAppliedGeneration },
        `mcp-config-delta out-of-order or duplicate — dropping`,
      );
      return;
    }
    if (frame.generation !== this.lastAppliedGeneration + 1) {
      this.log.warn(
        { generation: frame.generation, lastApplied: this.lastAppliedGeneration },
        `mcp-config-delta generation gap — requesting resync`,
      );
      this.requestResync("gap");
      return;
    }

    const perMcp: McpConfigAckFrame["perMcp"] = [];

    for (const entry of frame.added ?? []) {
      const result = await this.addEntry(entry);
      perMcp.push({ mcpId: entry.mcpId, name: entry.name, status: result.status, error: result.error });
    }
    for (const entry of frame.updated ?? []) {
      const prior = this.roster.get(entry.mcpId);
      if (!prior) {
        const result = await this.addEntry(entry);
        perMcp.push({ mcpId: entry.mcpId, name: entry.name, status: result.status, error: result.error });
      } else {
        const result = await this.updateEntry(prior, entry);
        perMcp.push({ mcpId: entry.mcpId, name: entry.name, status: result.status, error: result.error });
      }
    }
    for (const mcpId of frame.removed ?? []) {
      const prior = this.roster.get(mcpId);
      if (prior) {
        const result = await this.removeEntry(prior);
        perMcp.push({ mcpId, name: prior.name, status: result.status, error: result.error });
      } else {
        // Removing something we don't have — log + report removed (idempotent).
        this.log.warn({ mcpId }, `mcp-config-delta remove for unknown mcpId`);
        perMcp.push({ mcpId, name: "?", status: "removed" });
      }
    }

    this.lastAppliedGeneration = frame.generation;
    this.sendAck(frame.generation, perMcp);
  }

  // ─── private ────────────────────────────────────────────────────────────

  private cancelSnapshotWait(): void {
    if (this.snapshotWaitTimer) {
      clearTimeout(this.snapshotWaitTimer);
      this.snapshotWaitTimer = undefined;
    }
  }

  private requestResync(reason: McpConfigResyncFrame["reason"]): void {
    const frame: McpConfigResyncFrame = { type: "mcp-config-resync", reason };
    this.send(frame);
  }

  private sendAck(
    generation: number,
    perMcp: McpConfigAckFrame["perMcp"],
  ): void {
    const ack: McpConfigAckFrame = { type: "mcp-config-ack", generation, perMcp };
    this.send(ack);
  }

  private async addEntry(
    entry: McpConfigEntry,
  ): Promise<{ status: "started" | "failed" | "skipped"; error?: string }> {
    // Name collision. Two sources can clash here:
    //   1. A yaml entry registered first at boot (bundled / customer-authored).
    //   2. A different controller-config entry already in this roster (the
    //      controller UI should prevent this, but be defensive — duplicate
    //      delivery on reconnect or a controller-side bug shouldn't crash us).
    // Either way: don't shadow the first registration. Report failed with a
    // specific reason so the operator can fix the right side.
    if (this.opts.supervisor.hasEntry(entry.name)) {
      const otherMcpId = this.nameToMcpId.get(entry.name);
      const error = otherMcpId
        ? `name conflict with another controller-config entry (mcpId=${otherMcpId})`
        : `name conflict with yaml entry "${entry.name}"`;
      return { status: "failed", error };
    }
    const specOrError = this.toSpec(entry);
    if ("error" in specOrError) {
      return { status: "skipped", error: specOrError.error };
    }
    this.roster.set(entry.mcpId, { mcpId: entry.mcpId, name: entry.name, config: entry });
    this.nameToMcpId.set(entry.name, entry.mcpId);
    // W-E6: mark the supervisor entry as "controller-config" + carry the
    // mcpId so the inspector renders the right source badge + correlation
    // id. Yaml entries never come through this path.
    this.opts.supervisor.registerOne(specOrError.spec, { source: "controller-config", mcpId: entry.mcpId });
    // Pre-spawn creds fetch — see McpConfigCoordinatorBind.requestCreds.
    // The controller-config path arrives AFTER register-ack, so the boot
    // fan-out at lifecycle.ts:`requestCredsForAllMcps` has already iterated
    // `servers.keys()` without this entry. Without a fetch here, the next
    // `startOne` spawns the child with empty controllerEnv → stdio MCPs
    // that gate on env vars (e.g. our @deshartman/twilio-mcp) register
    // zero tools, the connector's discovery probe hits an empty server
    // and gets back -32601 from McpServer's lazy tools/list handler.
    //
    // Errors from the fetch are intentionally swallowed: the soft-wait
    // already logs a warn, and we want the spawn to proceed even if the
    // controller has no row for this MCP yet. The child can boot from
    // dir/.env or fail-fast with a clear "X must be set" error message
    // — same behaviour as a yaml entry whose creds never arrived.
    try {
      await this.requestCreds(entry.name, entry.mcpId, entry.envKeys ?? []);
    } catch (err) {
      this.log.warn(
        { mcp: entry.name, err: (err as Error).message },
        `pre-spawn creds fetch failed — spawning without controller env`,
      );
    }
    try {
      await this.opts.supervisor.startOne(entry.name, "controller-config-add");
      return { status: "started" };
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
  }

  private async updateEntry(
    prior: RosterEntry,
    next: McpConfigEntry,
  ): Promise<{ status: "started" | "failed" | "skipped"; error?: string }> {
    const specOrError = this.toSpec(next);
    if ("error" in specOrError) {
      return { status: "skipped", error: specOrError.error };
    }
    // Name change is supported: drop the old name → mcpId mapping and re-add.
    if (prior.name !== next.name) {
      await this.opts.supervisor.unregister(prior.name);
      this.nameToMcpId.delete(prior.name);
      this.opts.supervisor.registerOne(specOrError.spec, { source: "controller-config", mcpId: next.mcpId });
      this.nameToMcpId.set(next.name, next.mcpId);
      // Same pre-spawn fetch as addEntry — a rename re-spawns the child
      // under the new name, so the env-at-spawn-time invariant applies
      // identically. The controller's row is keyed by mcpId, so the
      // creds-response under the new name is what we want.
      try {
        await this.requestCreds(next.name, next.mcpId, next.envKeys ?? []);
      } catch (err) {
        this.log.warn(
          { mcp: next.name, err: (err as Error).message },
          `pre-rename creds fetch failed — spawning without controller env`,
        );
      }
      try {
        await this.opts.supervisor.startOne(next.name, "controller-config-rename");
        this.roster.set(next.mcpId, { mcpId: next.mcpId, name: next.name, config: next });
        return { status: "started" };
      } catch (err) {
        return { status: "failed", error: (err as Error).message };
      }
    }
    // Same name, different spec: replace + restart. The replaceSpec call
    // restarts the child; we re-fetch creds first so the restart picks up
    // the latest values (e.g. operator added an envKey, or rotated a value
    // through the same form). The wire frame's envKeys carries the current
    // list; the controller's response is idempotent so a refetch when
    // nothing changed is harmless beyond an extra round-trip.
    try {
      await this.requestCreds(next.name, next.mcpId, next.envKeys ?? []);
    } catch (err) {
      this.log.warn(
        { mcp: next.name, err: (err as Error).message },
        `pre-replace creds fetch failed — restarting without refreshed env`,
      );
    }
    try {
      await this.opts.supervisor.replaceSpec(next.name, specOrError.spec, "controller-config-update");
      this.roster.set(next.mcpId, { mcpId: next.mcpId, name: next.name, config: next });
      return { status: "started" };
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
  }

  private async removeEntry(
    prior: RosterEntry,
  ): Promise<{ status: "removed" | "failed"; error?: string }> {
    try {
      await this.opts.supervisor.unregister(prior.name);
      this.roster.delete(prior.mcpId);
      this.nameToMcpId.delete(prior.name);
      return { status: "removed" };
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
  }

  // Translate a controller-supplied McpConfigEntry into a SupervisedSpec the
  // supervisor knows how to spawn / connect.
  //
  // Stdio: straightforward — McpServerSpec stdio shape with command from
  //        the entry. Env values arrive via creds-response and merge in the
  //        supervisor's mergeEnv (existing path).
  //
  // http / streamable-http / sse / websocket: McpServerSpec http shape with
  //        endpoint = entry.url. Auth shape is stamped on the spec verbatim;
  //        the supervisor's resolveSpecHeaders (W-E3 / W-E4) translates it to
  //        spec.headers at every spawn / restart so a creds-update naturally
  //        re-resolves. The wire-side `transport` collapses to the supervisor's
  //        `http` McpServerSpec; the SUB-transport (streamable-http / sse /
  //        websocket) rides on `__transportKind` so servers/connect.ts can
  //        dispatch to the correct SDK client transport (W-E5).
  private toSpec(
    entry: McpConfigEntry,
  ): { spec: SupervisedSpec } | { error: string } {
    if (entry.transport === "stdio") {
      if (!entry.command || entry.command.length === 0) {
        return { error: `stdio entry "${entry.name}" missing command` };
      }
      const spec: McpServerSpec = {
        name: entry.name,
        transport: "stdio",
        command: entry.command,
        timeout_ms: 5000,
      };
      return { spec };
    }
    if (
      entry.transport === "http" ||
      entry.transport === "streamable-http" ||
      entry.transport === "sse" ||
      entry.transport === "websocket"
    ) {
      if (!entry.url) {
        return { error: `${entry.transport} entry "${entry.name}" missing url` };
      }
      // streamable-http (and the legacy "http" alias) → undefined kind →
      // servers/connect.ts dispatches to connectHttp (today's default).
      // sse / websocket get the kind stamped so dispatch routes to the
      // correct transport class.
      const kind: "sse" | "websocket" | undefined =
        entry.transport === "sse" ? "sse" :
        entry.transport === "websocket" ? "websocket" :
        undefined;
      const spec: McpServerSpec & { __transportKind?: "sse" | "websocket" } = {
        name: entry.name,
        transport: "http",
        endpoint: entry.url,
        auth: entry.auth,
        timeout_ms: 5000,
        ...(kind ? { __transportKind: kind } : {}),
      };
      return { spec };
    }
    return { error: `transport "${entry.transport}" not yet supported in this connector version` };
  }
}

// Compare two McpConfigEntry values structurally for snapshot reconciliation.
// Stable JSON serialization is good enough — entries are small and field
// order is deterministic for the same controller version.
function configEntryEquals(a: McpConfigEntry, b: McpConfigEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
