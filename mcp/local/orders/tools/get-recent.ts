import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Three fixtures keyed by phone, designed to exercise the three branches of
// the Refund Eligibility procedure's gates:
//   +14155550101 — 16 days old, delivered  → eligibility passes
//   +14155550102 — 47 days old, delivered  → fails (>30 day age gate)
//   +14155550103 —  8 days old, pending    → fails (status not delivered)
//
// `placedAt` is computed as `now - ageDays` at call time so that the ISO
// timestamp never disagrees with the ageDays we report — a future operator
// reading the response always sees mathematically consistent fields.
interface Fixture {
  orderId: string;
  ageDays: number;
  status: "delivered" | "pending" | "shipped" | "cancelled";
  channel: "web" | "store" | "phone";
  amount: number;
  currency: string;
}

const FIXTURES_BY_PHONE: Record<string, Fixture> = {
  "+14155550101": {
    orderId: "ord_42",
    ageDays: 16,
    status: "delivered",
    channel: "web",
    amount: 42.10,
    currency: "USD",
  },
  "+14155550102": {
    orderId: "ord_77",
    ageDays: 47,
    status: "delivered",
    channel: "store",
    amount: 128.99,
    currency: "USD",
  },
  "+14155550103": {
    orderId: "ord_91",
    ageDays: 8,
    status: "pending",
    channel: "web",
    amount: 19.50,
    currency: "USD",
  },
};

// Email fallback for the gift-order edge case in the procedure.
const FIXTURES_BY_EMAIL: Record<string, Fixture> = {
  "purchaser@example.com": {
    orderId: "ord_gift_5",
    ageDays: 12,
    status: "delivered",
    channel: "web",
    amount: 65.00,
    currency: "USD",
  },
};

function normalizePhone(raw: string): string {
  const stripped = raw.replace(/[\s()-]/g, "");
  return stripped.startsWith("+") ? stripped : stripped;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

        let fixture: Fixture | undefined;
        if (phone) fixture = FIXTURES_BY_PHONE[normalizePhone(phone)];
        if (!fixture && email) fixture = FIXTURES_BY_EMAIL[email.trim().toLowerCase()];

        if (!fixture) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "no_orders" }) },
            ],
          };
        }

        const placedAt = new Date(Date.now() - fixture.ageDays * DAY_MS).toISOString();
        const order = {
          orderId: fixture.orderId,
          placedAt,
          ageDays: fixture.ageDays,
          status: fixture.status,
          channel: fixture.channel,
          amount: fixture.amount,
          currency: fixture.currency,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(order, null, 2) }],
        };
      }
    );
  },
};
