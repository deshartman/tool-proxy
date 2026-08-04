// Workstream D / §9.1 + §9.4 — server→client notification ROUTER.
//
// MCP servers emit notifications to their connected client (per the spec):
// `notifications/progress`, `notifications/message` (logging),
// `notifications/resources/updated`, `notifications/{tools,prompts,resources}/
// list_changed`. A UI-only controller does NOT speak MCP, so the connector —
// the MCP terminator — must not relay raw MCP onto the tunnel. It translates:
//
//   * `*/list_changed`  → re-list + push a tunnel `manifest-delta` (the frame
//                          the controller already applies). Done via the
//                          injected `onListChanged` callback, wired in
//                          boot/lifecycle.ts to `refreshManifestAndPushDelta`.
//   * everything else   → DROPPED (§9.4, decision a). progress / message /
//                          resources/updated / cancelled carry no
//                          UI-actionable meaning for a controller that can't
//                          interpret MCP, and no tunnel consumer exists today.
//                          (The inspector still records them via message-tap —
//                          that path is independent of this router.)
//
// LIFETIME. Constructed ONCE per connector process; outlives WS reconnects —
// the supervisor's server connections are process-wide. Per-tunnel rebind only
// swaps the `onListChanged` callback via `bind(...)`; a list_changed that fires
// while the tunnel is down is dropped (the controller re-reads the manifest on
// its next register/reconnect anyway — the state is idempotent, not a queue).
//
// `attachToConnection` is called by the supervisor whenever a new
// McpServerConnection is established (boot, restart, controller-pushed roster
// add). Lifecycle is owned by the connection itself; closing it drops the
// listener. We hold no strong references to closed connections.
//
// DEBOUNCE. A server re-registering N tools fires N list_changed in a burst;
// one manifest refresh (which re-lists every server and diffs) covers them all.
// We coalesce to a single trailing refresh so a burst yields one manifest-delta.

import type { McpServerConnection, ServerNotification } from "../servers/index.js";
import type { Logger } from "../logger.js";

const LIST_CHANGED = new Set([
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/resources/list_changed",
]);

// Trailing-edge coalesce window for a list_changed burst.
const REFRESH_DEBOUNCE_MS = 250;

interface BindOpts {
  // Fired (debounced) when an upstream MCP reports a catalog change. Wired to
  // the connector's manifest re-list → manifest-delta path.
  onListChanged: () => void;
}

export class NotificationForwarder {
  private onListChanged: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly log: Logger) {}

  bind(opts: BindOpts): void {
    this.onListChanged = opts.onListChanged;
  }

  // Sever the callback when a tunnel closes. A list_changed fired during the
  // gap is dropped — no queue: the controller re-reads the manifest on its next
  // reconnect, so a missed refresh self-heals. A pending debounce is cancelled.
  unbind(): void {
    this.onListChanged = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // Register against a single MCP server connection. Idempotent per
  // (connection, name); the connection owns the listener lifecycle.
  attachToConnection(name: string, connection: McpServerConnection): void {
    connection.onNotification((notification) => this.route(name, notification));
  }

  private route(server: string, notification: ServerNotification): void {
    if (LIST_CHANGED.has(notification.method)) {
      this.scheduleRefresh(server, notification.method);
      return;
    }
    // §9.4 — consumed connector-side, not forwarded. Debug so a chatty MCP
    // doesn't spam warn/info.
    this.log.debug?.(
      { server, method: notification.method },
      `mcp notification consumed (no tunnel consumer)`,
    );
  }

  private scheduleRefresh(server: string, method: string): void {
    if (!this.onListChanged) {
      this.log.debug?.({ server, method }, `list_changed dropped (tunnel not bound)`);
      return;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.log.info({ server, method }, `upstream list_changed → refreshing manifest`);
      try {
        this.onListChanged?.();
      } catch (err) {
        this.log.warn({ server, err: err as Error }, `manifest refresh on list_changed failed`);
      }
    }, REFRESH_DEBOUNCE_MS);
  }
}
