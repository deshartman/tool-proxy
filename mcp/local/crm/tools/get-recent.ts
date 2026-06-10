import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Hydrates the customer's most recent order from the mock customer service
// (see mock/customers/). The MCP is a thin client — no fixtures live here
// any more.
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const body = res.status === 200 ? await res.json() : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

interface CustomerLookupResponse {
  customer: { name: string; surname: string; phone?: string; email?: string };
  mostRecent: {
    orderId: string;
    date: string;
    status: string;
    channel: string;
    amount: number;
    currency: string;
    reason: string;
    resolution: string;
  } | null;
}

export const getRecent: Tool = {
  name: "get_recent",
  register(server) {
    server.registerTool(
      "get_recent",
      {
        description:
          "Returns the customer's most recent order keyed by phone (preferred) or email (fallback). " +
          "Used by the Refund Eligibility procedure as a hydration tool.",
        // Property names are spelled with spaces deliberately: they match the
        // hydration reference labels in the controller-side procedure
        // ("customer phone", "original purchaser email") so the
        // HydrationService can pass the ctx bag through verbatim.
        inputSchema: {
          "customer phone": z
            .string()
            .optional()
            .describe("Customer phone number, E.164 format (e.g. +14155550101)."),
          "original purchaser email": z
            .string()
            .optional()
            .describe("Optional fallback used by gift-order edge cases."),
        },
      },
      async (args) => {
        const phone = args["customer phone"];
        const email = args["original purchaser email"];

        let response: CustomerLookupResponse | null = null;
        if (phone) {
          const r = await fetchJson(`${MOCK_URL}/customers?phone=${encodeURIComponent(phone)}`);
          if (r.status === 200) response = r.body as CustomerLookupResponse;
          else if (r.status !== 404) throw new Error(`mock-customers ${r.status}`);
        }
        if (!response && email) {
          const r = await fetchJson(`${MOCK_URL}/customers?email=${encodeURIComponent(email)}`);
          if (r.status === 200) response = r.body as CustomerLookupResponse;
          else if (r.status !== 404) throw new Error(`mock-customers ${r.status}`);
        }

        if (!response?.mostRecent) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "no_orders" }) },
            ],
          };
        }

        const recent = response.mostRecent;
        const ageDays = Math.floor((Date.now() - Date.parse(recent.date)) / (24 * 60 * 60 * 1000));
        const order = {
          orderId: recent.orderId,
          placedAt: recent.date,
          ageDays,
          status: recent.status,
          channel: recent.channel,
          amount: recent.amount,
          currency: recent.currency,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(order, null, 2) }],
        };
      }
    );
  },
};
