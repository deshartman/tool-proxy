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
  // Boot soft-wait. If no snapshot arrives within this window after
  // register-ack, the coordinator emits mcp-config-resync { reason: "boot" }
  // so an older controller surfaces explicitly rather than silently
  // running with an empty 3rd-party roster.
  bootSoftWaitMs?: number;
}

interface RosterEntry {
  mcpId: string;
  name: string;
  // The full McpConfigEntry as supplied by the controller — kept verbatim
  // so updates can diff against the prior shape and re-derive the spec.
  config: McpConfigEntry;
}

export class McpConfigCoordinator {
  // mcpId → roster entry. Snapshot reconciliation uses this as the prior
  // state; delta operations mutate it in place.
  private readonly roster = new Map<string, RosterEntry>();
  // name → mcpId. Lets us go from supervisor entry → roster entry on
  // creds frames.
  private readonly nameToMcpId = new Map<string, string>();
  private lastAppliedGeneration = -1;
  private readonly bootSoftWaitMs: number;
  private bootSoftWaitTimer?: NodeJS.Timeout;

  constructor(private readonly opts: McpConfigCoordinatorOpts) {
    this.bootSoftWaitMs = opts.bootSoftWaitMs ?? 5000;
  }

  // Called from the boot pipeline right after register-ack. Starts the
  // soft-wait that triggers a resync request if no snapshot lands.
  armBootSoftWait(): void {
    this.cancelBootSoftWait();
    this.bootSoftWaitTimer = setTimeout(() => {
      if (this.lastAppliedGeneration === -1) {
        this.opts.log.warn(
          {},
          `mcp-config-snapshot soft-wait elapsed — sending mcp-config-resync. older controller? running with empty 3rd-party roster.`,
        );
        this.requestResync("boot");
      }
    }, this.bootSoftWaitMs);
  }

  // Lookup the mcpId for a roster-sourced MCP by name. Used when building
  // creds-request frames so the controller can scope by (connectorId, mcpId).
  // Returns undefined for yaml-listed MCPs.
  mcpIdFor(name: string): string | undefined {
    return this.nameToMcpId.get(name);
  }

  async handleSnapshot(frame: McpConfigSnapshotFrame): Promise<void> {
    this.cancelBootSoftWait();
    if (frame.generation <= this.lastAppliedGeneration) {
      this.opts.log.warn(
        { generation: frame.generation, lastApplied: this.lastAppliedGeneration },
        `mcp-config-snapshot superseded — dropping`,
      );
      return;
    }
    this.opts.log.info(
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
      this.opts.log.warn(
        { generation: frame.generation, lastApplied: this.lastAppliedGeneration },
        `mcp-config-delta out-of-order or duplicate — dropping`,
      );
      return;
    }
    if (frame.generation !== this.lastAppliedGeneration + 1) {
      this.opts.log.warn(
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
      if (!prior) {
        // Removing something we don't have — log + report removed (idempotent).
        this.opts.log.warn({ mcpId }, `mcp-config-delta remove for unknown mcpId`);
        perMcp.push({ mcpId, name: "?", status: "removed" });
        continue;
      }
      const result = await this.removeEntry(prior);
      perMcp.push({ mcpId, name: prior.name, status: result.status, error: result.error });
    }

    this.lastAppliedGeneration = frame.generation;
    this.sendAck(frame.generation, perMcp);
  }

  // ─── private ────────────────────────────────────────────────────────────

  private cancelBootSoftWait(): void {
    if (this.bootSoftWaitTimer) {
      clearTimeout(this.bootSoftWaitTimer);
      this.bootSoftWaitTimer = undefined;
    }
  }

  private requestResync(reason: McpConfigResyncFrame["reason"]): void {
    const frame: McpConfigResyncFrame = { type: "mcp-config-resync", reason };
    this.opts.send(frame);
  }

  private sendAck(
    generation: number,
    perMcp: McpConfigAckFrame["perMcp"],
  ): void {
    const ack: McpConfigAckFrame = { type: "mcp-config-ack", generation, perMcp };
    this.opts.send(ack);
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
    this.opts.supervisor.registerOne(specOrError.spec);
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
      this.opts.supervisor.registerOne(specOrError.spec);
      this.nameToMcpId.set(next.name, next.mcpId);
      try {
        await this.opts.supervisor.startOne(next.name, "controller-config-rename");
        this.roster.set(next.mcpId, { mcpId: next.mcpId, name: next.name, config: next });
        return { status: "started" };
      } catch (err) {
        return { status: "failed", error: (err as Error).message };
      }
    }
    // Same name, different spec: replace + restart.
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
  // http / streamable-http: McpServerSpec http shape with endpoint = entry.url.
  //        Auth headers are NOT attached here — they're resolved at spawn time
  //        from the supervisor's controllerEnv (which lands via creds-response)
  //        and merged into spec.headers in W-E3's auth-resolution helper.
  //
  // sse / websocket: not yet implemented in the connector's outbound transport
  //        layer. Reported as status:"skipped" until W-E5 lands.
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
    if (entry.transport === "http" || entry.transport === "streamable-http") {
      if (!entry.url) {
        return { error: `${entry.transport} entry "${entry.name}" missing url` };
      }
      const spec: McpServerSpec = {
        name: entry.name,
        transport: "http",
        endpoint: entry.url,
        timeout_ms: 5000,
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
