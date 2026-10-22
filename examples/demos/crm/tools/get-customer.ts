import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { recordLookup } from "../resources/recent-lookups.js";
import { MOCK_URL, REQ_TIMEOUT_MS } from "../lib/backend.js";

// Identity lookup against the mock customer service. Returns name, surname,
// phone, email — no order history (callers that need that go to get_recent).
// On success, pushes the phone onto the recent-lookups resource for the
// procedure to read back at `crm://lookups/recent`.

interface CustomerLookupResponse {
  customer: { name: string; surname: string; phone?: string; email?: string };
}

// outputSchema describes the success-path projection target. The error
// envelope ({ error: "no_customer" }) is signalled via content[] only —
// per the OUTPUT-SCHEMA plan rule #5, structuredContent is set only on
// the success path so the SDK doesn't try to validate an error envelope
// against this success shape.
const OutputSchema = {
  name: z.string().describe("Customer's given name."),
  surname: z.string().describe("Customer's family name."),
  phone: z.string().nullable().describe("E.164 phone (canonical), or null if not on file."),
  email: z.string().nullable().describe("Email, or null if not on file."),
};

export const getCustomer: Tool = {
  name: "get_customer",
  envKeys: ["MOCK_CUSTOMERS_URL"],
  register(server) {
    server.registerTool(
      "get_customer",
      {
        title: "CRM Get Customer",
        description:
          "Returns the customer's identity profile (name, surname, phone, email) keyed by phone. " +
          "Identity only — order history is fetched separately via get_recent.",
        inputSchema: {
          customer_phone: z
            .string()
            .describe("Customer phone number, E.164 format (e.g. +15551239999)."),
        },
        outputSchema: OutputSchema,
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
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: "no_customer" }) }],
            };
          }
          if (!res.ok) throw new Error(`mock-customers ${res.status}`);
          const body = await res.json() as CustomerLookupResponse;
          const { name, surname, phone: phoneOut, email } = body.customer;
          const data = { name, surname, phone: phoneOut ?? null, email: email ?? null };
          recordLookup(phone);
          return {
            structuredContent: data,
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } finally {
          clearTimeout(timer);
        }
      }
    );
  },
};

export default getCustomer;
