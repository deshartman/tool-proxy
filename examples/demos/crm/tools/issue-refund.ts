import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import { MOCK_URL, REQ_TIMEOUT_MS } from "../lib/backend.js";

// In-memory ledger of refunds we've issued, keyed by orderId. The connector
// process is the only thing reading/writing this; restart wipes it.
//
// Two business failure modes:
//   1. amount > the order total fetched from the mock service.
//   2. orderId already refunded in this process's lifetime (double-refund).
//
// Order totals come from the mock customer service so this tool stays in
// sync with what get_recent returns. Idempotency stays here — it's a
// process-local concern, not customer data.
interface RefundRecord {
  refundId: string;
  amount: number;
  currency: string;
  issuedAt: string;
}

const REFUND_LEDGER = new Map<string, RefundRecord>();

async function fetchOrderTotal(orderId: string): Promise<number | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${MOCK_URL}/orders/${encodeURIComponent(orderId)}`, { signal: ctl.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`mock-customers ${res.status}`);
    const body = await res.json() as { amount?: number };
    return body.amount;
  } finally {
    clearTimeout(timer);
  }
}

function newRefundId(): string {
  return `ref_${randomBytes(6).toString("hex")}`;
}

// Success-path projection target. Both error envelopes (already_refunded,
// amount_exceeds_order_total) are signalled via content[] only — per the
// OUTPUT-SCHEMA plan rule #5, structuredContent is set only when the
// refund actually issues so the SDK doesn't validate the error envelope
// against this success shape.
const OutputSchema = {
  refundId: z.string().describe("Process-local refund identifier (ref_<hex>)."),
  orderId: z.string().describe("Echoed from the input — pin the link in projections."),
  amount: z.number().describe("Refunded amount, in the order's currency."),
  currency: z.string().describe("ISO 4217 currency code."),
  issuedAt: z.string().describe("Refund issuance timestamp, ISO 8601 UTC."),
  status: z.literal("issued").describe("Always 'issued' on the success path."),
  reason: z.string().nullable().describe("Free-text reason if supplied at call time, else null."),
};

export const issueRefund: Tool = {
  name: "issue_refund",
  envKeys: ["MOCK_CUSTOMERS_URL"],
  register(server) {
    server.registerTool(
      "issue_refund",
      {
        title: "CRM Issue Refund",
        description:
          "Issues a refund of the specified amount to the original payment method. " +
          "Refunds are idempotent per orderId — re-calling for the same order returns an error.",
        inputSchema: {
          orderId: z.string().describe("Order identifier returned by get_recent."),
          amount: z.number().positive().describe("Amount to refund, in the order's currency."),
          currency: z.string().default("USD").describe("ISO 4217 currency code."),
          reason: z.string().optional().describe("Free-text reason recorded with the refund."),
        },
        outputSchema: OutputSchema,
      },
      async ({ orderId, amount, currency, reason }) => {
        const existing = REFUND_LEDGER.get(orderId);
        if (existing) {
          return {
            isError: true,
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

        const orderTotal = await fetchOrderTotal(orderId);
        // MCP-AUDIT #5: an unknown order is a REFUSAL, not a free pass. The
        // guard below used to read `orderTotal !== undefined && amount > ...`,
        // so a 404 skipped the amount check entirely and the refund issued for
        // any amount against any string — returning status: "issued". Note the
        // asymmetry that made it worse: a backend that is *down* already refused
        // (fetchOrderTotal throws), so only "definitively unknown" was treated
        // as permission to proceed.
        if (orderTotal === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "order_not_found",
                  orderId,
                  detail: "No such order — refunds are only issued against an order returned by get_recent.",
                }),
              },
            ],
          };
        }
        if (amount > orderTotal + 0.001) {
          return {
            isError: true,
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

        const data = {
          refundId: record.refundId,
          orderId,
          amount: record.amount,
          currency: record.currency,
          issuedAt: record.issuedAt,
          status: "issued" as const,
          reason: reason ?? null,
        };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default issueRefund;
