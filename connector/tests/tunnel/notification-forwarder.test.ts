import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { NotificationForwarder } from "@connector/tunnel/notification-forwarder.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { Logger } from "@connector/logger.js";

// §9.1 + §9.4 — the notification ROUTER (was: raw forwarder).
//
// Pin the load-bearing properties:
//   * `*/list_changed` → ONE debounced `onListChanged()` (→ manifest-delta).
//   * a burst of list_changed coalesces to a single refresh.
//   * every OTHER notification (progress / message / resources/updated /
//     cancelled) is DROPPED — never triggers a refresh, never leaks onto the
//     tunnel as a raw mcp-notification.
//   * per-process forwarder: bind()/unbind() swap only the callback; a
//     list_changed before bind() or after unbind() is dropped (not queued),
//     and refreshes resume after rebind.
//   * a throwing onListChanged is logged and does not poison the upstream emit.

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

describe("NotificationForwarder (router)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("routes a list_changed to a single debounced onListChanged", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { refreshes++; } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/tools/list_changed" });
    expect(refreshes).toBe(0);       // debounced — not synchronous
    vi.runAllTimers();
    expect(refreshes).toBe(1);
  });

  it("coalesces a burst of list_changed (tools/prompts/resources) into one refresh", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { refreshes++; } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/tools/list_changed" });
    emit({ method: "notifications/prompts/list_changed" });
    emit({ method: "notifications/resources/list_changed" });
    vi.runAllTimers();

    expect(refreshes).toBe(1);       // one manifest refresh covers the burst
  });

  it("DROPS non-list_changed notifications — no refresh, no tunnel leak", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { refreshes++; } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/progress", params: { progressToken: "t1", progress: 1, total: 4 } });
    emit({ method: "notifications/resources/updated", params: { uri: "ek://sources/abc" } });
    emit({ method: "notifications/message", params: { level: "info", logger: "demo", data: "hi" } });
    emit({ method: "notifications/cancelled", params: { requestId: 7 } });
    vi.runAllTimers();

    expect(refreshes).toBe(0);
  });

  it("drops list_changed fired before bind() and resumes after bind", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    // Note: NO bind() yet.

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/tools/list_changed" });
    vi.runAllTimers();
    expect(refreshes).toBe(0);

    fwd.bind({ onListChanged: () => { refreshes++; } });
    emit({ method: "notifications/tools/list_changed" });
    vi.runAllTimers();
    expect(refreshes).toBe(1);
  });

  it("drops list_changed after unbind() (tunnel-down) and resumes after rebind", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { refreshes++; } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/tools/list_changed" });
    vi.runAllTimers();
    expect(refreshes).toBe(1);

    // Tunnel closes — a pending/new list_changed must not fire.
    fwd.unbind();
    emit({ method: "notifications/tools/list_changed" });
    vi.runAllTimers();
    expect(refreshes).toBe(1);

    // Reconnect.
    fwd.bind({ onListChanged: () => { refreshes++; } });
    emit({ method: "notifications/tools/list_changed" });
    vi.runAllTimers();
    expect(refreshes).toBe(2);
  });

  it("unbind() cancels a pending debounced refresh", () => {
    const { log } = makeLog();
    let refreshes = 0;
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { refreshes++; } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    emit({ method: "notifications/tools/list_changed" });  // schedule
    fwd.unbind();                                          // cancel before it fires
    vi.runAllTimers();
    expect(refreshes).toBe(0);
  });

  it("a throwing onListChanged is logged and doesn't propagate to the upstream emit", () => {
    const { log, warns } = makeLog();
    const fwd = new NotificationForwarder(log);
    fwd.bind({ onListChanged: () => { throw new Error("refresh blew up"); } });

    const { conn, emit } = makeFakeConnection();
    fwd.attachToConnection("ek", conn);

    // The upstream MCP client must not be poisoned by a connector-side hiccup.
    // The throw happens inside the debounced timer callback.
    emit({ method: "notifications/tools/list_changed" });
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(warns).toHaveLength(1);
  });
});
