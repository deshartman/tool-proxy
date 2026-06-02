import type { WebSocket } from "ws";
import type { ConnectorView, ToolManifest, ManifestDelta } from "./types.js";
import { eventBus } from "./event-bus.js";

interface ConnectorEntry {
  ws: WebSocket;
  view: ConnectorView;
  pending: Map<string | number, (resp: unknown) => void>;
}

class Registry {
  private connectors = new Map<string, ConnectorEntry>();
  private nextRpcId = 1;

  add(connectorId: string, ws: WebSocket, manifest: ToolManifest): void {
    const view: ConnectorView = {
      connectorId,
      environment: manifest.environment,
      version: manifest.version,
      status: "online",
      lastHeartbeatTs: Date.now(),
      manifest,
    };
    this.connectors.set(connectorId, { ws, view, pending: new Map() });
    this.broadcastRegistry();
  }

  remove(connectorId: string): void {
    const entry = this.connectors.get(connectorId);
    if (!entry) return;
    // Reject any in-flight calls.
    for (const fn of entry.pending.values()) {
      fn({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "connector disconnected" } });
    }
    this.connectors.delete(connectorId);
    this.broadcastRegistry();
  }

  heartbeat(connectorId: string): void {
    const entry = this.connectors.get(connectorId);
    if (!entry) return;
    entry.view.lastHeartbeatTs = Date.now();
    if (entry.view.status !== "online") {
      entry.view.status = "online";
      this.broadcastRegistry();
    }
  }

  applyDelta(connectorId: string, delta: ManifestDelta): void {
    const entry = this.connectors.get(connectorId);
    if (!entry) return;
    const m = entry.view.manifest;
    for (const r of delta.removed) {
      const s = m.servers.find((x) => x.name === r.server);
      if (s) s.tools = s.tools.filter((t) => t.name !== r.tool);
    }
    for (const c of delta.changed) {
      const s = m.servers.find((x) => x.name === c.server);
      if (!s) continue;
      const i = s.tools.findIndex((t) => t.name === c.tool.name);
      if (i >= 0) s.tools[i] = c.tool;
    }
    for (const a of delta.added) {
      let s = m.servers.find((x) => x.name === a.server);
      if (!s) {
        s = { name: a.server, transport: "http", tools: [] };
        m.servers.push(s);
      }
      s.tools.push(a.tool);
    }
    this.broadcastRegistry();
  }

  list(): ConnectorView[] {
    return [...this.connectors.values()].map((e) => e.view);
  }

  // Track an outstanding RPC call. Returns the id to use in the request.
  registerPending(connectorId: string, resolve: (resp: unknown) => void): number | undefined {
    const entry = this.connectors.get(connectorId);
    if (!entry) return undefined;
    const id = this.nextRpcId++;
    entry.pending.set(id, resolve);
    return id;
  }

  resolvePending(connectorId: string, id: string | number, resp: unknown): void {
    const entry = this.connectors.get(connectorId);
    if (!entry) return;
    const fn = entry.pending.get(id);
    if (!fn) return;
    entry.pending.delete(id);
    fn(resp);
  }

  cancelPending(connectorId: string, id: string | number): void {
    const entry = this.connectors.get(connectorId);
    entry?.pending.delete(id);
  }

  send(connectorId: string, frame: unknown): boolean {
    const entry = this.connectors.get(connectorId);
    if (!entry) return false;
    if (entry.ws.readyState !== entry.ws.OPEN) return false;
    entry.ws.send(JSON.stringify(frame));
    return true;
  }

  // Mark stale if no heartbeat for >3× the connector's interval (~4.5s).
  // This is a UI hint, not a disconnect.
  markStale(): void {
    const cutoff = Date.now() - 4500;
    let changed = false;
    for (const e of this.connectors.values()) {
      if (e.view.status === "online" && (e.view.lastHeartbeatTs ?? 0) < cutoff) {
        e.view.status = "stale";
        changed = true;
      }
    }
    if (changed) this.broadcastRegistry();
  }

  private broadcastRegistry(): void {
    eventBus.publish({ kind: "registry", connectors: this.list() });
  }
}

export const registry = new Registry();
