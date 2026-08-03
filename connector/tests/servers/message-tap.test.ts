import { describe, it, expect } from "vitest";

import { wrapWithMessageTap, type McpMessageTap } from "@connector/servers/message-tap.js";
import type { McpServerConnection, ServerNotification } from "@connector/servers/index.js";

// Pins the decorator's request/response/error/notification tapping in
// isolation, against a hand-built fake McpServerConnection — no SDK Client,
// no supervisor, no HTTP. See .claude/plans/MCP-STATUS-DETAIL.md for the
// feature this backs (inspector MCP Status → message-history pane).

interface FakeConnection extends McpServerConnection {
  fireNotification(n: ServerNotification): void;
}

function fakeConnection(overrides: Partial<McpServerConnection> = {}): FakeConnection {
  const handlers = new Set<(n: ServerNotification) => void>();
  return {
    name: "fake",
    transport: "http",
    async listTools() { return []; },
    async callTool(name: string, args: unknown) { return { name, args }; },
    async listPrompts() { return []; },
    async getPrompt() { return {}; },
    async listResources() { return []; },
    async listResourceTemplates() { return []; },
    async readResource() { return {}; },
    async subscribeResource() { return {}; },
    async unsubscribeResource() { return {}; },
    async complete() { return {}; },
    async setLoggingLevel() { return {}; },
    onNotification(handler: (n: ServerNotification) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() { /* noop */ },
    fireNotification(n: ServerNotification) {
      for (const h of handlers) h(n);
    },
    ...overrides,
  };
}

describe("wrapWithMessageTap", () => {
  it("records an out/request tap then an in/response tap, in order, for a successful call", async () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection();
    const wrapped = wrapWithMessageTap("alpha", conn, (t) => taps.push(t));

    const result = await wrapped.callTool("echo", { x: 1 }, { timeoutMs: 1000 });

    expect(result).toEqual({ name: "echo", args: { x: 1 } });
    expect(taps).toHaveLength(2);
    expect(taps[0]).toMatchObject({ mcp: "alpha", direction: "out", kind: "request", method: "callTool" });
    expect(taps[1]).toMatchObject({ mcp: "alpha", direction: "in", kind: "response", method: "callTool", payload: result });
    // "out" tap must land strictly before "in" — assert via timestamp ordering.
    expect(taps[0].ts).toBeLessThanOrEqual(taps[1].ts);
  });

  it("records an error tap (with the error message as payload) and still rethrows the original error", async () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection({ callTool: async () => { throw new Error("boom"); } });
    const wrapped = wrapWithMessageTap("alpha", conn, (t) => taps.push(t));

    await expect(wrapped.callTool("x", {}, { timeoutMs: 1000 })).rejects.toThrow("boom");
    expect(taps).toHaveLength(2);
    expect(taps[0]).toMatchObject({ direction: "out", kind: "request", method: "callTool" });
    expect(taps[1]).toMatchObject({ direction: "in", kind: "error", method: "callTool", payload: { message: "boom" } });
  });

  it("taps every wrapped request/response method, not just callTool", async () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection();
    const wrapped = wrapWithMessageTap("alpha", conn, (t) => taps.push(t));

    await wrapped.listTools();
    await wrapped.listPrompts();
    await wrapped.getPrompt("p", undefined, { timeoutMs: 1000 });
    await wrapped.listResources();
    await wrapped.listResourceTemplates();
    await wrapped.readResource("uri", { timeoutMs: 1000 });
    await wrapped.subscribeResource("uri", { timeoutMs: 1000 });
    await wrapped.unsubscribeResource("uri", { timeoutMs: 1000 });
    await wrapped.complete({}, { timeoutMs: 1000 });
    await wrapped.setLoggingLevel("info", { timeoutMs: 1000 });

    const methods = taps.map((t) => t.method);
    for (const expected of [
      "listTools", "listPrompts", "getPrompt", "listResources", "listResourceTemplates",
      "readResource", "subscribeResource", "unsubscribeResource", "complete", "setLoggingLevel",
    ]) {
      expect(methods).toContain(expected);
    }
    // Every request got a matching response — 10 methods × (out + in) = 20.
    expect(taps).toHaveLength(20);
  });

  it("taps notifications and still forwards them to the original handler untouched", () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection();
    const wrapped = wrapWithMessageTap("alpha", conn, (t) => taps.push(t));

    const received: ServerNotification[] = [];
    wrapped.onNotification((n) => received.push(n));
    conn.fireNotification({ method: "notifications/message", params: { level: "info" } });

    expect(received).toEqual([{ method: "notifications/message", params: { level: "info" } }]);
    expect(taps).toHaveLength(1);
    expect(taps[0]).toMatchObject({
      mcp: "alpha", direction: "in", kind: "notification",
      method: "notifications/message", payload: { level: "info" },
    });
  });

  it("does not tap close()", async () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection();
    const wrapped = wrapWithMessageTap("alpha", conn, (t) => taps.push(t));

    await wrapped.close();

    expect(taps).toHaveLength(0);
  });

  it("stamps every tap's mcp field with the name passed to wrapWithMessageTap", async () => {
    const taps: McpMessageTap[] = [];
    const conn = fakeConnection();
    const wrapped = wrapWithMessageTap("beta", conn, (t) => taps.push(t));

    await wrapped.listTools();

    expect(taps.length).toBeGreaterThan(0);
    expect(taps.every((t) => t.mcp === "beta")).toBe(true);
  });
});
