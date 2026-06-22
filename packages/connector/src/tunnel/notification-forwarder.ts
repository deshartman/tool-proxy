// Workstream D — server→client notification forwarding.
//
// MCP servers can emit notifications to their connected client (per the spec):
// `notifications/progress`, `notifications/message` (logging),
// `notifications/resources/updated`, `notifications/{tools,prompts,resources}/list_changed`.
// The connector wraps each as an `mcp-notification` frame and forwards to the
// controller, which correlates progress by `params.progressToken`, resource
// updates by `params.uri`, list_changed by `server`.
//
// LIFETIME. The forwarder is constructed ONCE per connector process and
// outlives WS reconnects — the supervisor's server connections are also
// process-wide. Per-tunnel rebind only swaps the wire `send` callback via
// `bind({send})`; pending dispatches before bind are dropped (logged once)
// so a notification fired during a brief tunnel close doesn't crash.
//
// `attachToConnection` is called by the supervisor whenever a new
// McpServerConnection is established (boot, restart, controller-pushed
// roster add). It returns the unsubscribe — but lifecycle is owned by the
// connection itself; closing the connection drops the listener. We don't
// hold strong references to closed connections.
//
// SAFETY. The send callback is synchronous (no per-frame await) so a burst
// of notifications doesn't starve heartbeat scheduling — same invariant the
// webhook frame respected. JSON.stringify already happens inside
// TunnelClient.send; we don't preformat.

import type { McpServerConnection, ServerNotification } from "../servers/index.js";
import type { McpNotificationFrame } from "./frames.js";
import type { Logger } from "../logger.js";

interface BindOpts {
  send: (frame: McpNotificationFrame) => void;
}

export class NotificationForwarder {
  private send: ((frame: McpNotificationFrame) => void) | undefined;

  constructor(private readonly log: Logger) {}

  bind(opts: BindOpts): void {
    this.send = opts.send;
  }

  // Sever the wire callback when a tunnel closes. Notifications fired during
  // the gap are dropped — they're advisory by spec, and the controller will
  // re-list-resources / re-fetch progress on its next call once the tunnel
  // is back. No queue here on purpose: queueing risks unbounded growth on a
  // long outage, and stale progress events are worse than missing ones.
  unbind(): void {
    this.send = undefined;
  }

  // Register a forwarder against a single MCP server connection. Idempotent
  // per (connection, name) pair — caller (supervisor) attaches once at
  // connect-time, doesn't need to deregister on disconnect (the connection
  // owns the listener).
  attachToConnection(name: string, connection: McpServerConnection): void {
    connection.onNotification((notification) => this.forward(name, notification));
  }

  private forward(server: string, notification: ServerNotification): void {
    if (!this.send) {
      // First drop on a given tunnel-down period — log at debug so a busy
      // MCP doesn't spam warn during a reconnect cycle. The spec says
      // notifications are advisory; consumer state will recover.
      this.log.debug?.({ server, method: notification.method }, `notification dropped (tunnel not bound)`);
      return;
    }
    const frame: McpNotificationFrame = {
      type: "mcp-notification",
      server,
      payload: { method: notification.method, params: notification.params },
    };
    try {
      this.send(frame);
    } catch (err) {
      this.log.warn({ server, method: notification.method, err: err as Error }, `failed to forward MCP notification`);
    }
  }
}
