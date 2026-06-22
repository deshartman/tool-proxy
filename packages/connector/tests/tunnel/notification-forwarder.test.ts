import { describe, it, expect } from "vitest";

import { NotificationForwarder } from "@connector/tunnel/notification-forwarder.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { McpNotificationFrame } from "@connector/tunnel/frames.js";
import type { Logger } from "@connector/logger.js";

// Defensive tests for the v1.2 server→client notification path.
//
// Pin the load-bearing properties:
//   * forward EVERY notification a connection emits as `mcp-notification`
//     wrapping the original JSON-RPC envelope verbatim.
//   * the forwarder is per-process — bind() / unbind() swap only the wire
//     callback, listeners on existing connections survive WS reconnect.
//   * notifications fired BEFORE bind() (pre-handshake) or AFTER unbind()
//     (during a tunnel-down period) are dropped — not queued. This is
//     deliberate: queueing risks unbounded memory on a long outage, and
//     stale progress events are worse than missing ones.

interface FakeConnection {
  attach: (handler: (n: { method: string; params?: unknown }) => void) => void;
  emit: (n: { method: string; params?: unknown }) => void;
}

function makeFakeConnection(): { conn: McpServerConnection; emit: (n: { method: string; params?: unknown }) => void } {
  let listener: ((n: { method: string; params?: unknown }) => void) | undefined;
  const conn: Partial<McpServerConnection> = {
    name: "fake",
    transport: "http",
    onNotification(handler) {
      listener = handler;
      return () => { listener = undefined; };
    },
  };
  return {
    conn: conn as McpServerConnection,
    emit: (n) => listener?.(n),
  };
}

function makeLog(): { log: Logger; warns: unknown[] } {
  const warns: unknown[] = [];
  const log = {
    info: () => undefined,
    warn: (ctx: unknown) => { warns.push(ctx); },
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    level: "info" as const,
    child: () => log as unknown as Logger,
  } as unknown as Logger;
  return { log, warns };
}

describe("NotificationForwarder", () => {
  it("wraps fired notifications as mcp-notification frames", () => {
    const { log } = makeLog();
    const sent: McpNotificationFrame[] = [];
    const fwd = new NotificationForwarder(log);
    fwd.bind({ send: (f) => sent.push(f) });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/progress", params: { progressToken: "t1", progress: 1, total: 4 } });
    emit({ method: "notifications/resources/updated", params: { uri: "ek://sources/abc" } });
    emit({ method: "notifications/message", params: { level: "info", logger: "demo", data: "hi" } });

    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({
      type: "mcp-notification",
      server: "ek",
      payload: { method: "notifications/progress", params: { progressToken: "t1", progress: 1, total: 4 } },
    });
    expect(sent[1].payload).toEqual({ method: "notifications/resources/updated", params: { uri: "ek://sources/abc" } });
    expect(sent[2].payload).toEqual({ method: "notifications/message", params: { level: "info", logger: "demo", data: "hi" } });
  });

  it("drops notifications fired before bind() (pre-handshake)", () => {
    const { log } = makeLog();
    const sent: McpNotificationFrame[] = [];
    const fwd = new NotificationForwarder(log);
    // Note: NO bind() call.

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/progress", params: { progressToken: "t1", progress: 1 } });

    expect(sent).toHaveLength(0);

    // Bind, fire again — now flowing.
    fwd.bind({ send: (f) => sent.push(f) });
    emit({ method: "notifications/progress", params: { progressToken: "t1", progress: 2 } });
    expect(sent).toHaveLength(1);
  });

  it("drops notifications fired after unbind() (tunnel-down period) and resumes after rebind", () => {
    const { log } = makeLog();
    const sent: McpNotificationFrame[] = [];
    const fwd = new NotificationForwarder(log);
    fwd.bind({ send: (f) => sent.push(f) });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/progress", params: { progress: 1 } });
    expect(sent).toHaveLength(1);

    // Tunnel closes.
    fwd.unbind();
    emit({ method: "notifications/progress", params: { progress: 2 } });
    emit({ method: "notifications/resources/updated", params: { uri: "x://y" } });
    expect(sent).toHaveLength(1); // still 1 — both drops

    // Reconnect.
    fwd.bind({ send: (f) => sent.push(f) });
    emit({ method: "notifications/progress", params: { progress: 3 } });
    expect(sent).toHaveLength(2);
    expect((sent[1].payload as { params: { progress: number } }).params.progress).toBe(3);
  });

  it("a throwing send callback is logged and doesn't propagate to the upstream notification", () => {
    const { log, warns } = makeLog();
    const fwd = new NotificationForwarder(log);
    fwd.bind({ send: () => { throw new Error("ws closed mid-frame"); } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    // emit should not throw — the upstream MCP client must not be poisoned
    // by a tunnel-side hiccup.
    expect(() => emit({ method: "notifications/progress", params: {} })).not.toThrow();

    expect(warns).toHaveLength(1);
  });
});
