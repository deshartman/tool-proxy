import { describe, it, expect } from "vitest";

import { Inspector, type InspectorEvent } from "@connector/inspector/server.js";
import type { McpMessageTap } from "@connector/servers/message-tap.js";

// Pins Inspector's per-MCP message-log ring buffer: cap + eviction order,
// per-mcp isolation, clear, and the SSE broadcasts that back the inspector's
// MCP Status → message-history pane. See .claude/plans/MCP-STATUS-DETAIL.md.

function buildInspector(): Inspector {
  return new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
}

function tap(mcp: string, ts: number, method = "callTool"): McpMessageTap {
  return { mcp, direction: "out", kind: "request", method, payload: { n: ts }, ts };
}

describe("Inspector MCP message log", () => {
  it("getMcpMessages returns [] for an MCP with no recorded taps", () => {
    const inspector = buildInspector();
    expect(inspector.getMcpMessages("nope")).toEqual([]);
  });

  it("recordMcpMessage then getMcpMessages round-trips the tap", () => {
    const inspector = buildInspector();
    const t = tap("alpha", 1);
    inspector.recordMcpMessage(t);
    expect(inspector.getMcpMessages("alpha")).toEqual([t]);
  });

  it("caps the per-mcp ring buffer at 500, evicting the oldest first", () => {
    const inspector = buildInspector();
    for (let i = 1; i <= 501; i++) {
      inspector.recordMcpMessage(tap("alpha", i));
    }
    const messages = inspector.getMcpMessages("alpha");
    expect(messages).toHaveLength(500);
    // Tap #1 was evicted; #2 is now the oldest retained.
    expect(messages[0].ts).toBe(2);
    expect(messages[messages.length - 1].ts).toBe(501);
  });

  it("keeps per-mcp logs isolated — taps for one MCP don't leak into another's", () => {
    const inspector = buildInspector();
    inspector.recordMcpMessage(tap("a", 1));
    inspector.recordMcpMessage(tap("b", 2));
    inspector.recordMcpMessage(tap("a", 3));

    expect(inspector.getMcpMessages("a").map((m) => m.ts)).toEqual([1, 3]);
    expect(inspector.getMcpMessages("b").map((m) => m.ts)).toEqual([2]);
  });

  it("getMcpMessages returns a copy — mutating the result doesn't affect the stored log", () => {
    const inspector = buildInspector();
    inspector.recordMcpMessage(tap("alpha", 1));
    const messages = inspector.getMcpMessages("alpha");
    messages.push(tap("alpha", 2));
    expect(inspector.getMcpMessages("alpha")).toHaveLength(1);
  });

  it("clearMcpMessages empties the log for that MCP only", () => {
    const inspector = buildInspector();
    inspector.recordMcpMessage(tap("a", 1));
    inspector.recordMcpMessage(tap("b", 2));

    inspector.clearMcpMessages("a");

    expect(inspector.getMcpMessages("a")).toEqual([]);
    expect(inspector.getMcpMessages("b")).toHaveLength(1);
  });

  it("recordMcpMessage broadcasts a mcpMessage SSE event to subscribers", () => {
    const inspector = buildInspector();
    const events: InspectorEvent[] = [];
    inspector.subscribe((e) => events.push(e));

    const t = tap("alpha", 1);
    inspector.recordMcpMessage(t);

    expect(events).toEqual([{ kind: "mcpMessage", tap: t }]);
  });

  it("clearMcpMessages broadcasts a mcpMessagesCleared SSE event to subscribers", () => {
    const inspector = buildInspector();
    inspector.recordMcpMessage(tap("alpha", 1));
    const events: InspectorEvent[] = [];
    inspector.subscribe((e) => events.push(e));

    inspector.clearMcpMessages("alpha");

    expect(events).toEqual([{ kind: "mcpMessagesCleared", mcp: "alpha" }]);
  });

  it("does not include per-mcp message logs in snapshot() (fetched on demand instead)", () => {
    const inspector = buildInspector();
    inspector.recordMcpMessage(tap("alpha", 1));

    const snapshot = inspector.snapshot();

    expect(JSON.stringify(snapshot)).not.toContain("mcpMessages");
    expect((snapshot as unknown as { messages?: unknown }).messages).toBeUndefined();
  });
});
