import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Identity lookup against the mock customer service. Returns name, surname,
// phone, email — no order history (callers that need that go to get_recent).
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

interface CustomerLookupResponse {
  customer: { name: string; surname: string; phone?: string; email?: string };
}

export const getCustomer: Tool = {
  name: "get_customer",
  register(server) {
    server.registerTool(
      "get_customer",
      {
        description:
          "Returns the customer's identity profile (name, surname, phone, email) keyed by phone. " +
          "Identity only — order history is fetched separately via get_recent.",
        inputSchema: {
          customer_phone: z
            .string()
            .describe("Customer phone number, E.164 format (e.g. +15551239999)."),
        },
      },
      async ({ customer_phone: phone }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${MOCK_URL}/customers?phone=${encodeURIComponent(phone)}`,
            { signal: ctl.signal }
          );
          if (res.status === 404) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "no_customer" }) }],
            };
          }
          if (!res.ok) throw new Error(`mock-customers ${res.status}`);
          const body = await res.json() as CustomerLookupResponse;
          const { name, surname, phone: phoneOut, email } = body.customer;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ name, surname, phone: phoneOut ?? null, email: email ?? null }, null, 2),
              },
            ],
          };
        } finally {
          clearTimeout(timer);
        }
      }
    );
  },
};
