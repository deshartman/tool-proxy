import { describe, it, expect, afterEach, vi } from "vitest";

import { issueRefund } from "../../../../../mcp/local/crm/tools/issue-refund.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// crm.issue_refund has three mutually-exclusive paths:
//   1. fresh refund        → success shape with structuredContent
//   2. amount > total      → error envelope, content[] only
//   3. already refunded    → error envelope, content[] only
// Plan rule #5 says only the success path carries structuredContent.

describe("crm.issue_refund handler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns structuredContent that round-trips through outputSchema on success", async () => {
    const reg = captureRegistration(issueRefund);
    expect(reg.outputSchema).toBeDefined();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ amount: 100.0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({
        // Use a fresh orderId — issueRefund's REFUND_LEDGER is module-state,
        // so a repeated id across tests would collide.
        orderId: `ord_test_${Math.floor(performance.now() * 1000)}_${process.pid}`,
        amount: 50,
        currency: "USD",
        reason: "test",
      }),
    );

    expect(result.structuredContent).toBeDefined();
    const schema = asZodObject(reg.outputSchema);
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
    // Sanity: the schema contract carries refundId + status:"issued" — pin
    // those so a drift to a different status enum value gets caught.
    const parsed = schema.parse(result.structuredContent) as {
      refundId: string;
      status: string;
    };
    expect(parsed.refundId).toMatch(/^ref_/);
    expect(parsed.status).toBe("issued");
  });

  it("does NOT set structuredContent on amount_exceeds_order_total", async () => {
    const reg = captureRegistration(issueRefund);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ amount: 10.0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({
        orderId: `ord_excess_${Math.floor(performance.now() * 1000)}_${process.pid}`,
        amount: 50,
        currency: "USD",
      }),
    );
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("amount_exceeds_order_total");
  });

  it("does NOT set structuredContent on already_refunded (idempotency error)", async () => {
    const reg = captureRegistration(issueRefund);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ amount: 100.0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const orderId = `ord_dupe_${Math.floor(performance.now() * 1000)}_${process.pid}`;
    // First call seeds the ledger.
    await reg.handler({ orderId, amount: 50, currency: "USD" });
    // Second call hits the ledger guard.
    const result = asToolResult(await reg.handler({ orderId, amount: 50, currency: "USD" }));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("already_refunded");
  });
});
