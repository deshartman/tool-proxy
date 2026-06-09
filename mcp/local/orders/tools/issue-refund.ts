import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";

// In-memory ledger of refunds we've issued, keyed by orderId. The connector
// process is the only thing reading/writing this; restart wipes it. The
// demo's two real failure modes are both checked here:
//
//   1. amount > the order total we'd return from get_recent — caller is
//      asking for more than was paid.
//   2. orderId already refunded in this process's lifetime — caller is
//      double-refunding.
//
// Real systems consult a payments DB; the in-memory map is enough to show
// the side-effect tool returning a structured business failure that the LLM
// has to handle.
interface RefundRecord {
  refundId: string;
  amount: number;
  currency: string;
  issuedAt: string;
}

const REFUND_LEDGER = new Map<string, RefundRecord>();

// Mirror of the order totals get_recent returns. Kept in sync by hand —
// these are demo fixtures, not a shared source of truth.
const ORDER_TOTALS: Record<string, number> = {
  ord_42: 42.10,
  ord_77: 128.99,
  ord_91: 19.50,
  ord_gift_5: 65.00,
};

function newRefundId(): string {
  return `ref_${randomBytes(6).toString("hex")}`;
}

export const issueRefund: Tool = {
  name: "issue_refund",
  register(server) {
    server.registerTool(
      "issue_refund",
      {
        description:
          "Issues a refund of the specified amount to the original payment method. " +
          "Refunds are idempotent per orderId — re-calling for the same order returns an error.",
        inputSchema: {
          orderId: z.string().describe("Order identifier returned by get_recent."),
          amount: z.number().positive().describe("Amount to refund, in the order's currency."),
          currency: z.string().default("USD").describe("ISO 4217 currency code."),
          reason: z.string().optional().describe("Free-text reason recorded with the refund."),
        },
      },
      async ({ orderId, amount, currency, reason }) => {
        const existing = REFUND_LEDGER.get(orderId);
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "already_refunded",
                  orderId,
                  refundId: existing.refundId,
                  issuedAt: existing.issuedAt,
                }),
              },
            ],
          };
        }

        const orderTotal = ORDER_TOTALS[orderId];
        if (orderTotal !== undefined && amount > orderTotal + 0.001) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "amount_exceeds_order_total",
                  orderId,
                  requested: amount,
                  orderTotal,
                  currency,
                }),
              },
            ],
          };
        }

        const record: RefundRecord = {
          refundId: newRefundId(),
          amount,
          currency,
          issuedAt: new Date().toISOString(),
        };
        REFUND_LEDGER.set(orderId, record);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  refundId: record.refundId,
                  orderId,
                  amount: record.amount,
                  currency: record.currency,
                  issuedAt: record.issuedAt,
                  status: "issued",
                  reason: reason ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  },
};
