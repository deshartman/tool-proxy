import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

// MCP-AUDIT #5 — issue_refund must not fail open when the order lookup 404s.
//
// The guard read `if (orderTotal !== undefined && amount > orderTotal + 0.001)`.
// fetchOrderTotal returns undefined on HTTP 404, so an unknown order made the
// first conjunct false and skipped the amount check entirely — the refund issued
// for any amount against any string, returning status: "issued" and a refundId.
//
// The asymmetry sharpened it: a backend that is DOWN already refused, because
// fetchOrderTotal throws on a non-404 or when the 4s AbortController fires. Only
// "definitively unknown" was treated as permission to proceed, which is the exact
// inversion of what the tool's own description promises.
//
// This is a demo, so no money moves — but it is the worked example customers copy
// for a write tool.

const CRM = resolve(__dirname, "../../..", "examples/demos/crm");

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}>;

// Minimal stand-in for McpServer: capture the handler registerTool is given.
function captureHandler(tool: { register(server: unknown): void }): Handler {
  let handler: Handler | undefined;
  tool.register({
    registerTool: (_name: string, _spec: unknown, fn: Handler) => { handler = fn; },
  } as never);
  if (!handler) throw new Error("tool did not register a handler");
  return handler;
}

const payload = (r: Awaited<ReturnType<Handler>>): Record<string, unknown> =>
  JSON.parse(r.content[0].text) as Record<string, unknown>;

let issueRefund: Handler;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import(`${CRM}/tools/issue-refund.ts?v=${Date.now()}`);
  issueRefund = captureHandler(mod.default ?? mod.issueRefund);
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string) => { status: number; body?: unknown }): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const { status, body } = impl(String(url));
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }));
}

describe("MCP-AUDIT #5 — an unknown order is refused, not refunded", () => {
  it("refuses with order_not_found when the backend 404s", async () => {
    stubFetch(() => ({ status: 404 }));
    const r = await issueRefund({ orderId: "does-not-exist", amount: 1_000_000, currency: "USD" });

    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("order_not_found");
    // The pre-fix behaviour, spelled out so a regression is unmistakable.
    expect(payload(r).error).not.toBe(undefined);
    expect(r.structuredContent).toBeUndefined();
  });

  it("does not consume the idempotency ledger when it refuses", async () => {
    // A refused call must leave the order refundable once it really exists.
    stubFetch(() => ({ status: 404 }));
    await issueRefund({ orderId: "later-real", amount: 5, currency: "USD" });

    stubFetch(() => ({ status: 200, body: { amount: 50 } }));
    const ok = await issueRefund({ orderId: "later-real", amount: 5, currency: "USD" });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent?.status).toBe("issued");
  });
});

describe("MCP-AUDIT #5 — the existing contract still holds", () => {
  it("issues a refund within the order total", async () => {
    stubFetch(() => ({ status: 200, body: { amount: 100 } }));
    const r = await issueRefund({ orderId: "ord_1", amount: 40, currency: "USD" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.status).toBe("issued");
    expect(r.structuredContent?.amount).toBe(40);
    expect(String(r.structuredContent?.refundId)).toMatch(/^ref_[0-9a-f]{12}$/);
  });

  it("still rejects an amount above the order total", async () => {
    stubFetch(() => ({ status: 200, body: { amount: 100 } }));
    const r = await issueRefund({ orderId: "ord_2", amount: 100.5, currency: "USD" });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("amount_exceeds_order_total");
  });

  it("allows the exact order total (the 0.001 float tolerance)", async () => {
    stubFetch(() => ({ status: 200, body: { amount: 100 } }));
    const r = await issueRefund({ orderId: "ord_3", amount: 100, currency: "USD" });
    expect(r.isError).toBeUndefined();
  });

  it("still refuses a second refund for the same order", async () => {
    stubFetch(() => ({ status: 200, body: { amount: 100 } }));
    await issueRefund({ orderId: "ord_4", amount: 10, currency: "USD" });
    const again = await issueRefund({ orderId: "ord_4", amount: 10, currency: "USD" });
    expect(again.isError).toBe(true);
    expect(payload(again).error).toBe("already_refunded");
  });

  it("still propagates a backend failure rather than refunding blind", async () => {
    // Non-404 throws inside fetchOrderTotal — the pre-fix code already refused
    // here, which is what made the 404 path's fail-open so inconsistent.
    stubFetch(() => ({ status: 500 }));
    await expect(issueRefund({ orderId: "ord_5", amount: 10, currency: "USD" })).rejects.toThrow();
  });
});
