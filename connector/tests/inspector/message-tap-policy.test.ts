import { describe, it, expect } from "vitest";

import { Inspector } from "../../src/inspector/server.js";
import { redactTapPayload } from "../../src/policy/redact.js";
import type { McpMessageTap } from "../../src/servers/message-tap.js";

// MCP-AUDIT #10 — the inspector's message tap vs. policy.log_tool_args.
//
// The dispatcher renders the same arguments through renderArgsForLog(), so an
// operator could get redaction in the log stream and cleartext in the inspector.
// The resolution is deliberately asymmetric, and both halves are pinned here:
//
//   * `redacted` (the DEFAULT) still records verbatim. The pane exists so a
//     developer can see what went into a tool; redacting at a setting nobody
//     chose would break the feature for everyone. Documented as an exemption in
//     docs/INSPECTOR.md rather than silently true.
//   * `none` redacts. Nobody reaches that setting by accident, so it reads as
//     "do not record tool arguments anywhere".
//
// Scoped to REQUEST payloads: `log_tool_args` is named after arguments and makes
// no claim about results.

const tap = (over: Partial<McpMessageTap> = {}): McpMessageTap => ({
  mcp: "crm",
  direction: "out",
  kind: "request",
  method: "callTool",
  payload: [{ name: "issue_refund", arguments: { orderId: "ord_1", amount: 5 } }],
  ts: 1,
  ...over,
});

describe("message tap vs policy.log_tool_args (MCP-AUDIT #10)", () => {
  it("hides request args when the operator explicitly set `none`", () => {
    const out = redactTapPayload(tap(), "none");
    expect(out.payload).toBe("<args hidden by policy.log_tool_args=none>");
    // Envelope preserved — the pane still shows that the call happened.
    expect(out).toMatchObject({ mcp: "crm", direction: "out", kind: "request", method: "callTool", ts: 1 });
  });

  it("leaves results alone even at `none` — a result is not an argument", () => {
    const result = tap({ kind: "response", direction: "in", payload: { total: 42 } });
    expect(redactTapPayload(result, "none").payload).toEqual({ total: 42 });
  });

  it("records verbatim at the default `redacted`, by design", () => {
    const t = tap();
    expect(redactTapPayload(t, "redacted")).toBe(t);
  });

  it("records verbatim at `full`", () => {
    const t = tap();
    expect(redactTapPayload(t, "full")).toBe(t);
  });

  it("does not mutate the tap it is given", () => {
    const t = tap();
    const original = structuredClone(t.payload);
    redactTapPayload(t, "none");
    expect(t.payload).toEqual(original);
  });
});

describe("message tap payload cap (MCP-AUDIT #10, secondary)", () => {
  it("elides a payload over the per-entry cap, naming its real size", () => {
    const inspector = new Inspector({ controllerUrl: "http://x", state: "closed" });
    const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "x".repeat(40) })) };
    const size = JSON.stringify(big).length;
    expect(size).toBeGreaterThan(32 * 1024);

    inspector.recordMcpMessage(tap({ kind: "response", direction: "in", payload: big }));

    const [stored] = inspector.getMcpMessages("crm");
    expect(stored.payload).toBe(`<elided: ${size} bytes exceeds the ${32 * 1024}-byte per-entry cap>`);
  });

  it("stores a normal payload untouched", () => {
    const inspector = new Inspector({ controllerUrl: "http://x", state: "closed" });
    inspector.recordMcpMessage(tap({ kind: "response", direction: "in", payload: { total: 42 } }));
    expect(inspector.getMcpMessages("crm")[0].payload).toEqual({ total: 42 });
  });

  it("broadcasts the capped entry, not the original", () => {
    const inspector = new Inspector({ controllerUrl: "http://x", state: "closed" });
    const seen: unknown[] = [];
    inspector.subscribe((e) => { if (e.kind === "mcpMessage") seen.push(e.tap.payload); });
    inspector.recordMcpMessage(tap({ payload: { pad: "x".repeat(40_000) } }));
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toMatch(/^<elided: \d+ bytes/);
  });

  it("passes a cyclic payload through rather than throwing", () => {
    const inspector = new Inspector({ controllerUrl: "http://x", state: "closed" });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => inspector.recordMcpMessage(tap({ payload: cyclic }))).not.toThrow();
    expect(inspector.getMcpMessages("crm")).toHaveLength(1);
  });
});
