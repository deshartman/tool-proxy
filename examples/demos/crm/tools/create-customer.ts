import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { recordLookup } from "../resources/recent-lookups.js";

// Operator-facing write tool. Creates a customer + optional inline
// orders in one round-trip. Backed by the mock-backend's POST /customers
// endpoint (which is Postgres-backed since MOCK-BACKEND-DB — see
// `examples/mock-backend/README.md`). Available to procedures too, but
// the primary caller is the operator via the inspector's tool-click
// form.
//
// The tool doesn't touch Postgres directly — the mock-backend owns the
// DB creds. Same HTTP boundary every other CRM tool uses.
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

// Response body echoes what get_customer would return for the same
// person, so the operator can eyeball what got inserted and downstream
// procedures can bind field-projected references immediately after
// creation (e.g. `[create_customer.customer.name]`).
const InteractionSchema = {
  orderId: z.string().describe("Stable order identifier."),
  status: z.string().describe("Fulfillment status."),
  total: z.number().describe("Order total in the order's currency."),
  currency: z.string().describe("ISO 4217 currency code."),
  placedAt: z.string().describe("Order placement timestamp, ISO 8601."),
};

const CustomerSchema = {
  name: z.string().describe("Given name."),
  surname: z.string().describe("Family name."),
  phone: z.string().nullable().describe("E.164 phone, or null if not on file."),
  email: z.string().nullable().describe("Email, or null if not on file."),
};

const OutputSchema = {
  customer: z.object(CustomerSchema).describe("The freshly-inserted customer's identity profile."),
  orders: z.array(z.object(InteractionSchema)).describe("Orders inserted alongside the customer (empty if none supplied)."),
};

interface CreateCustomerResponse {
  customer: {
    name: string;
    surname: string;
    phone?: string;
    email?: string;
    interactions?: Array<{
      orderId: string;
      date: string;
      status: string;
      channel: string;
      amount: number;
      currency: string;
      reason: string;
      resolution: string;
    }>;
  };
}

export const createCustomer: Tool = {
  name: "create_customer",
  register(server) {
    server.registerTool(
      "create_customer",
      {
        title: "CRM Create Customer",
        description:
          "Insert a customer into the CRM database, optionally with a batch of orders. " +
          "At least one of `phone` or `email` is required (both is fine — each is uniquely " +
          "indexed). Returns { customer, orders } on success. Error envelopes: " +
          "`duplicate_phone` / `duplicate_email` (409) via content[] with isError=true; " +
          "`validation_error` (400) same shape.",
        inputSchema: {
          name: z.string().min(1).describe("Given name."),
          surname: z.string().min(1).describe("Family name."),
          phone: z
            .string()
            .optional()
            .describe("Customer phone in E.164 (e.g. +15551239999). Required if email is absent."),
          email: z
            .string()
            .optional()
            .describe("Customer email. Required if phone is absent. Case-insensitive uniqueness."),
          interactions: z
            .array(
              z.object({
                orderId: z.string().describe("Stable order identifier (e.g. ord_alex_1)."),
                placedAt: z.string().describe("Order placement timestamp, ISO 8601 UTC."),
                status: z.enum(["delivered", "pending", "shipped", "cancelled"]).describe("Fulfillment status."),
                channel: z.enum(["web", "store", "phone"]).describe("Order channel."),
                amount: z.number().positive().describe("Order total in the order's currency."),
                currency: z.string().default("USD").describe("ISO 4217 currency code."),
                reason: z.string().optional().describe("Free-text reason recorded with the order."),
                resolution: z.string().optional().describe("Free-text resolution recorded with the order."),
              }),
            )
            .optional()
            .describe("Optional inline orders. Absent or empty = customer with no orders."),
        },
        outputSchema: OutputSchema,
      },
      async ({ name, surname, phone, email, interactions }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(`${MOCK_URL}/customers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, surname, phone, email, interactions }),
            signal: ctl.signal,
          });
          const body = await res.json() as CreateCustomerResponse | { error: string; detail?: string };
          if (!res.ok) {
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(body) }],
            };
          }
          const success = body as CreateCustomerResponse;
          const orders = (success.customer.interactions ?? []).map((i) => ({
            id: i.orderId,
            status: i.status.toLowerCase(),
            total: Number(i.amount.toFixed(2)),
            currency: i.currency,
            placedAt: new Date(i.date).toISOString(),
          }));
          const data = {
            customer: {
              name: success.customer.name,
              surname: success.customer.surname,
              phone: success.customer.phone ?? null,
              email: success.customer.email ?? null,
            },
            orders,
          };
          // Pushing the freshly-created phone onto the recent-lookups
          // resource makes crm://lookups/recent immediately useful — an
          // operator inserting a customer via this tool will see them
          // appear at the top without having to call get_customer first.
          if (success.customer.phone) recordLookup(success.customer.phone);
          return {
            structuredContent: data,
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );
  },
};

export default createCustomer;
