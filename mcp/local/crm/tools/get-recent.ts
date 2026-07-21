import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Hydration-role tool: takes a phone number and returns the customer's
// recent orders in a shape the cloud server can field-project against
// (e.g. [get-recent-orders.orders[0].id]). The outputSchema below is the
// contract: when the controller-side procedure references a field, it
// resolves against this shape.
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

interface Interaction {
  orderId: string;
  date: string;
  status: string;
  channel: string;
  amount: number;
  currency: string;
  reason: string;
  resolution: string;
}

interface CustomerLookupResponse {
  customer: {
    name: string;
    surname: string;
    phone?: string;
    email?: string;
    interactions: Interaction[];
  };
  mostRecent: Interaction | null;
}

// outputSchema describes the projection target — what authors reference as
// [get-recent-orders.orders[0].id]. content[0].text and structuredContent
// both carry this same shape; success/failure is signalled via isError, not
// an in-payload envelope (per MCP Tools / Tool Result spec).
const OrderSchema = {
  id: z.string().describe("Stable order identifier."),
  status: z.string().describe("Fulfillment status (e.g. delivered, shipped, pending, cancelled)."),
  total: z.number().describe("Order total in the order's currency, as a decimal number."),
  currency: z.string().describe("ISO 4217 currency code, e.g. USD."),
  placedAt: z.string().describe("Order placement timestamp, ISO 8601."),
};

const OutputSchema = {
  orders: z.array(z.object(OrderSchema)),
  customerId: z.string().describe("Stable identifier for the customer; today this is their E.164 phone."),
};

// Map the mock's Interaction onto the public Order shape. Reference syntax
// like [get-recent-orders.orders[0].total] inlines these values into the
// runtime LLM prompt as-is, so anything that needs further formatting before
// it's customer-quotable (minor-unit math, tz-offset arithmetic, status
// casing) is a missed normalisation at this boundary.
function interactionToOrder(
  i: Interaction
): { id: string; status: string; total: number; currency: string; placedAt: string } {
  return {
    id: i.orderId,
    status: i.status.toLowerCase(),
    total: Number(i.amount.toFixed(2)),
    currency: i.currency,
    placedAt: new Date(i.date).toISOString(),
  };
}

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

export const getRecent: Tool = {
  name: "get_recent",
  register(server) {
    server.registerTool(
      "get_recent",
      {
        title: "CRM Get Recent Orders",
        description:
          "Returns the customer's recent orders keyed by phone. Hydration tool: " +
          "the cloud server projects fields like [get-recent-orders.orders[0].id] " +
          "from the outputSchema below.",
        inputSchema: {
          phone: z
            .string()
            .describe("Customer phone number, E.164 format (e.g. +14155550101)."),
        },
        outputSchema: OutputSchema,
      },
      async (args) => {
        const phone = args.phone;

        const r = await fetchJson(
          `${MOCK_URL}/customers?phone=${encodeURIComponent(phone)}`
        );
        if (r.status !== 200 && r.status !== 404) {
          throw new Error(`mock-customers ${r.status}`);
        }
        const response = r.status === 200 ? (r.body as CustomerLookupResponse) : null;

        // Mock service ships interactions unsorted; mirror what mostRecent()
        // does (newest first by ISO date) so orders[0] is the most recent.
        const interactions = [...(response?.customer.interactions ?? [])].sort(
          (a, b) => b.date.localeCompare(a.date)
        );
        const orders = interactions.map(interactionToOrder);
        const data = { orders, customerId: phone };

        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};
