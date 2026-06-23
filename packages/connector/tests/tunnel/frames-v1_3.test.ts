import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  InboundTunnelFrame,
  McpDisableFrame,
  McpDiscoveredFrame,
  McpEnableAckFrame,
  McpEnableFrame,
  TunnelFrame,
} from "../../src/tunnel/frames.js";

// v1.3 — Customer drop-in approval gate. Pin the wire-format shape so
// (a) controller-side typings stay in lockstep with this discriminated union
// and (b) JSON-roundtrip preserves every load-bearing field. Frames are pure
// TS interfaces today (no zod schema); these tests catch silent shape drift
// and the discriminated-union membership a refactor would otherwise erode.

describe("v1.3 frame shape — mcp-discovered", () => {
  it("round-trips through JSON without losing fields", () => {
    const frame: McpDiscoveredFrame = {
      type: "mcp-discovered",
      mcp: "crm",
      author: "customer",
      source: "local",
      envKeys: ["MOCK_CUSTOMERS_URL"],
      tools: [
        { name: "get_customer", description: "Look up a customer by phone." },
        { name: "issue_refund" }, // description optional per spec
      ],
      discoveredAt: "2026-06-23T12:00:00Z",
    };

    const wire = JSON.stringify(frame);
    const decoded = JSON.parse(wire) as McpDiscoveredFrame;

    expect(decoded.type).toBe("mcp-discovered");
    expect(decoded.mcp).toBe("crm");
    // The two literal-typed fields are the gate predicate. A refactor
    // that loosens these to `string` would defeat the whole point.
    expect(decoded.author).toBe("customer");
    expect(decoded.source).toBe("local");
    expect(decoded.envKeys).toEqual(["MOCK_CUSTOMERS_URL"]);
    expect(decoded.tools).toHaveLength(2);
    expect(decoded.tools[0]).toEqual({ name: "get_customer", description: "Look up a customer by phone." });
    expect(decoded.tools[1]).toEqual({ name: "issue_refund" });
    expect(decoded.discoveredAt).toBe("2026-06-23T12:00:00Z");
  });

  it("is a member of the outbound TunnelFrame union", () => {
    // Type-level assertion: a McpDiscoveredFrame must be assignable to
    // TunnelFrame. If a future refactor accidentally drops it from the
    // outbound union (so `pendingTunnel.send(frame)` would type-error),
    // this test fails to compile.
    expectTypeOf<McpDiscoveredFrame>().toMatchTypeOf<TunnelFrame>();
  });
});

describe("v1.3 frame shape — mcp-enable", () => {
  it("accepts the inline-creds form (initial approval)", () => {
    const frame: McpEnableFrame = {
      type: "mcp-enable",
      mcp: "crm",
      env: { MOCK_CUSTOMERS_URL: "https://mock.internal:7400" },
      source: "operator-entered",
    };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpEnableFrame;
    expect(decoded.type).toBe("mcp-enable");
    expect(decoded.env?.MOCK_CUSTOMERS_URL).toBe("https://mock.internal:7400");
    expect(decoded.source).toBe("operator-entered");
  });

  it("accepts the bare form (replay-on-register-ack, no env change)", () => {
    const frame: McpEnableFrame = { type: "mcp-enable", mcp: "crm" };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpEnableFrame;
    expect(decoded.type).toBe("mcp-enable");
    expect(decoded.mcp).toBe("crm");
    expect(decoded.env).toBeUndefined();
    expect(decoded.source).toBeUndefined();
  });

  it("is a member of the InboundTunnelFrame union", () => {
    expectTypeOf<McpEnableFrame>().toMatchTypeOf<InboundTunnelFrame>();
  });
});

describe("v1.3 frame shape — mcp-disable", () => {
  it("carries no payload beyond the mcp name (no `stop` field — see DA5)", () => {
    const frame: McpDisableFrame = { type: "mcp-disable", mcp: "crm" };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpDisableFrame;
    expect(decoded.type).toBe("mcp-disable");
    expect(decoded.mcp).toBe("crm");
    // Pin the absence: any wire-shape addition here (e.g. `stop?: boolean`)
    // would change the gate's semantics from "manifest-visibility-only"
    // to "lifecycle gate", which DA5 explicitly rejected. Don't widen
    // this without a fresh decision.
    expect(Object.keys(decoded)).toEqual(["type", "mcp"]);
  });

  it("is a member of the InboundTunnelFrame union", () => {
    expectTypeOf<McpDisableFrame>().toMatchTypeOf<InboundTunnelFrame>();
  });
});

describe("v1.3 frame shape — mcp-enable-ack", () => {
  it("encodes the success branch with toolsCount", () => {
    const frame: McpEnableAckFrame = {
      type: "mcp-enable-ack",
      mcp: "crm",
      status: "enabled",
      toolsCount: 3,
    };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpEnableAckFrame;
    expect(decoded.status).toBe("enabled");
    expect(decoded.toolsCount).toBe(3);
    expect(decoded.error).toBeUndefined();
  });

  it("encodes the disable branch", () => {
    const frame: McpEnableAckFrame = {
      type: "mcp-enable-ack",
      mcp: "crm",
      status: "disabled",
    };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpEnableAckFrame;
    expect(decoded.status).toBe("disabled");
    expect(decoded.toolsCount).toBeUndefined();
    expect(decoded.error).toBeUndefined();
  });

  it("encodes the error branch with reason", () => {
    const frame: McpEnableAckFrame = {
      type: "mcp-enable-ack",
      mcp: "ghost",
      status: "error",
      error: "unknown_mcp",
    };
    const decoded = JSON.parse(JSON.stringify(frame)) as McpEnableAckFrame;
    expect(decoded.status).toBe("error");
    expect(decoded.error).toBe("unknown_mcp");
    expect(decoded.toolsCount).toBeUndefined();
  });

  it("is a member of the outbound TunnelFrame union", () => {
    expectTypeOf<McpEnableAckFrame>().toMatchTypeOf<TunnelFrame>();
  });
});
