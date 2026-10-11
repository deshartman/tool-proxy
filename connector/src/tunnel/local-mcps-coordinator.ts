// Local-MCP rescan coordinator (W-L2 of MCP-LOADING-LOCAL).
//
// The customer drops a folder under ${MCP_DROPIN_DIR}/<name>/tools/*.ts.
// The connector's drop-in scanner picks it up at boot. Without this
// coordinator, picking it up at runtime requires a process restart.
//
// Triggered two ways, both ending in the same rescan() call:
//   * controller → connector: `local-mcps-rescan` frame from the
//     "Refresh local MCPs" button in the controller UI
//   * inspector POST /mcp/rescan-local: loopback-only, for local-dev
//     iteration without a controller round-trip
//
// rescan() re-runs discoverDropins({yamlNames}) and reconciles by diff
// against the running supervisor entries:
//   * added   → registerOne(spec, {source: "local"}) → startOne(name)
//               + onMcpAdded. Under lazy spawn (startOnAdd: false) the
//               start is skipped: onMcpAdded announces the folder from the
//               DiscoveryCache and the child starts on its mcp-enable.
//   * removed → unregister(name)
//   * changed → present before and after, but its code fingerprint moved
//               (only when `fingerprint` is supplied) → onMcpChanged. The ack
//               still lists it under `unchanged` — the frame has no "changed"
//               field, and the folder SET did not change.
//
// Manifest changes ride the existing manifest-delta path (the supervisor's
// onRestart callback in boot/workspace.ts triggers refreshManifestAndPushDelta
// on every replaceSpec, and a supervisor.startOne wakes up the boot wiring's
// existing manifest builder via the same callback chain). The dedicated
// local-mcps-rescan-ack carries only the diff summary.
//
// LIFETIME — same shape as McpConfigCoordinator (read its LIFETIME comment
// before changing this one). Constructed ONCE per workspace (TunnelWorkspace): the
// coordinator's only state is an in-flight debounce flag, which must NOT
// reset on WS reconnect — a click against the inspector during a
// controller-triggered rescan should still be deduped. Per-tunnel rebind
// goes through bind({send}) which only swaps the wire send callback.

import type { LocalMcpsRescanAckFrame, TunnelFrame } from "./frames.js";
import type { McpSupervisor, SupervisedSpec } from "../mcp-supervisor.js";
import type { Logger } from "../logger.js";
import { discoverDropins, type DropinSpec } from "../dropin.js";

export interface LocalMcpsCoordinatorOpts {
  send: (frame: TunnelFrame) => void;
  supervisor: McpSupervisor;
  log: Logger;
  // Names already declared in connector.yaml — drop-in discovery skips these
  // because the yaml entry wins. Read once at boot and threaded through.
  yamlNames: Set<string>;
  // Called after a rescan applies its added/removed/changed diff so the boot
  // wiring can refresh the manifest, push a delta, and update the inspector.
  // Optional — when omitted the rescan still completes and the existing
  // discovery interval timer refreshes the manifest at its own cadence.
  onApplied?: () => void | Promise<void>;
  // Called after a successful add/replace so the boot wiring can fan out a
  // creds-request for the freshly-spawned MCP. The connector already issues
  // creds-request for every MCP at boot; rescan-added MCPs missed that
  // window, so the coordinator wakes them up here. Optional.
  // Returns the new MCP's tool count when it knows one without a running
  // child (lazy spawn: from the DiscoveryCache), for the ack.
  onMcpAdded?: (name: string) => void | number | Promise<void | number>;
  // false = register an added folder without starting it (lazy spawn, §5.3).
  // Default true, the pre-Phase-6 behaviour.
  startOnAdd?: boolean;
  // Code fingerprint of a folder (DiscoveryCache's folderFingerprint). When
  // supplied, a rescan detects a folder whose code changed and calls
  // onMcpChanged with its fresh spec. `initial` seeds the baseline with the
  // folders discovered at boot, so a change made before the first rescan is
  // still seen.
  fingerprint?: (dir: string) => string;
  initial?: DropinSpec[];
  onMcpChanged?: (spec: DropinSpec) => void | Promise<void>;
}

export interface LocalMcpsCoordinatorBind {
  send: (frame: TunnelFrame) => void;
  log?: Logger;
}

export class LocalMcpsCoordinator {
  // Wire-side hooks. Replaced via bind() on every tunnel reconnect.
  private send: (frame: TunnelFrame) => void;
  private log: Logger;
  // Single-flight guard. A second click while a rescan is mid-flight no-ops
  // — the in-flight scan covers the new state too. Cheaper than a debounce
  // window.
  private rescanInFlight = false;
  // name → code fingerprint as of the last scan that saw it.
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly opts: LocalMcpsCoordinatorOpts) {
    this.send = opts.send;
    this.log = opts.log;
    for (const spec of opts.initial ?? []) this.remember(spec);
  }

  // Per-tunnel rebind. Same contract as McpConfigCoordinator.bind: swap the
  // wire send callback so frames emitted by an in-flight rescan reach the
  // current tunnel, NOT a closed one.
  bind(b: LocalMcpsCoordinatorBind): void {
    this.send = b.send;
    if (b.log) this.log = b.log;
  }

  // Trigger a rescan. Returns the diff summary so an inspector caller can
  // surface it directly (the controller-triggered path discards the return
  // and relies on the local-mcps-rescan-ack frame instead).
  async rescan(): Promise<LocalMcpsRescanAckFrame> {
    if (this.rescanInFlight) {
      this.log.info(`local-mcps rescan already in flight — coalescing`);
      return { type: "local-mcps-rescan-ack", added: [], removed: [], unchanged: [], errors: [] };
    }
    this.rescanInFlight = true;
    try {
      return await this.rescanInner();
    } finally {
      this.rescanInFlight = false;
    }
  }

  // Controller-triggered entry point. Same as rescan() but also emits the
  // ack frame on the wire. Inspector path uses rescan() directly.
  async rescanFromController(): Promise<void> {
    const ack = await this.rescan();
    this.send(ack);
  }

  // ─── private ────────────────────────────────────────────────────────────

  private async rescanInner(): Promise<LocalMcpsRescanAckFrame> {
    const fresh = discoverDropins({ yamlNames: this.opts.yamlNames });
    const freshByName = new Map<string, DropinSpec>(fresh.map((spec) => [spec.name, spec]));

    // The supervisor exposes only its entry status, not the entry specs.
    // We track which names *we* registered as drop-ins via the status
    // source field — entries with source "local" are ours to manage.
    const priorLocalNames = new Set(
      this.opts.supervisor.statusList()
        .filter((s) => s.source === "local")
        .map((s) => s.name),
    );

    const added: { name: string; toolsCount: number }[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    const errors: { name: string; error: string }[] = [];

    // Removed: prior local entries no longer in the fresh scan.
    for (const name of priorLocalNames) {
      if (!freshByName.has(name)) {
        try {
          await this.opts.supervisor.unregister(name);
          removed.push(name);
        } catch (err) {
          errors.push({ name, error: (err as Error).message });
        }
      }
    }

    // Added: fresh entries the supervisor doesn't know about. (Yaml-name
    // collisions are already filtered by discoverDropins({yamlNames}); a
    // name collision against a controller-config entry returns an error
    // from the supervisor.)
    //
    // Changed: present in both — we don't track per-spec hashes here, so
    // mark as unchanged. (A future enhancement could compare spec.env or
    // discovered tool-file mtimes; out of scope for L2's "operator clicked
    // refresh" flow.)
    const changed: string[] = [];
    for (const spec of fresh) {
      if (this.opts.supervisor.hasEntry(spec.name)) {
        unchanged.push(spec.name);
        if (this.codeChanged(spec)) {
          try {
            await this.opts.onMcpChanged?.(spec);
            this.remember(spec);
            changed.push(spec.name);
          } catch (err) {
            errors.push({ name: spec.name, error: (err as Error).message });
          }
        }
        continue;
      }
      try {
        this.opts.supervisor.registerOne(spec, { source: "local" });
        if (this.opts.startOnAdd !== false) {
          await this.opts.supervisor.startOne(spec.name, "local-mcps-rescan");
        }
        // Fan out creds-request (eager) or mcp-discovered (lazy) for the new
        // MCP via the workspace's hook. Both normally run after register-ack;
        // rescan-added entries miss that window, so we wake them up here.
        const count = await this.opts.onMcpAdded?.(spec.name);
        this.remember(spec);
        // Eager: tools count comes from the manifest builder via onApplied
        // below. Lazy: the hook answered from the DiscoveryCache.
        added.push({ name: spec.name, toolsCount: typeof count === "number" ? count : 0 });
      } catch (err) {
        errors.push({ name: spec.name, error: (err as Error).message });
      }
    }
    for (const name of removed) this.fingerprints.delete(name);

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      try {
        await this.opts.onApplied?.();
        // After onApplied refreshes the manifest, fill in the toolsCounts
        // we couldn't supply during the spawn loop.
        for (const item of added) {
          const status = this.opts.supervisor.statusList().find((s) => s.name === item.name);
          if (status && status.process === "running") item.toolsCount = status.toolsCount;
        }
      } catch (err) {
        this.log.error({ err: err as Error }, `local-mcps rescan onApplied hook failed`);
      }
    }

    this.log.info(
      { added: added.map((a) => a.name), removed, unchanged, changed, errorCount: errors.length },
      `local-mcps rescan applied`,
    );

    return { type: "local-mcps-rescan-ack", added, removed, unchanged, errors };
  }

  private remember(spec: DropinSpec): void {
    if (this.opts.fingerprint && spec.dir) this.fingerprints.set(spec.name, this.opts.fingerprint(spec.dir));
  }

  // A folder with no baseline is not "changed" — it gets one now, so the
  // NEXT edit is seen. Only reachable for an entry the coordinator did not
  // add and was not seeded with.
  private codeChanged(spec: DropinSpec): boolean {
    if (!this.opts.fingerprint || !spec.dir) return false;
    const prior = this.fingerprints.get(spec.name);
    if (prior === undefined) { this.remember(spec); return false; }
    return prior !== this.opts.fingerprint(spec.dir);
  }
}

// Helper: best-effort assert that a supervised spec is a drop-in. Used by
// tests; the runtime path uses isDropinSpec from dropin.ts directly.
export function isLocalSpec(spec: SupervisedSpec): boolean {
  return (spec as { __dropin?: boolean }).__dropin === true;
}
