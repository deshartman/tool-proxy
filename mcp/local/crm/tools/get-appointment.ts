import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Returns the customer's next upcoming appointment keyed by phone. The
// reschedule procedure calls this to find the appointment to move; if there
// is none the procedure short-circuits.
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

export const getAppointment: Tool = {
  name: "get_appointment",
  register(server) {
    server.registerTool(
      "get_appointment",
      {
        description:
          "Returns the customer's next upcoming appointment (appointmentId, agentName, " +
          "start, end, status) keyed by phone. Returns { error: 'no_appointment' } when " +
          "the customer has no upcoming bookings.",
        inputSchema: {
          phone: z
            .string()
            .describe("Customer phone number, E.164 format (e.g. +61401277115)."),
        },
      },
      async ({ phone }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${MOCK_URL}/appointments?phone=${encodeURIComponent(phone)}`,
            { signal: ctl.signal },
          );
          if (res.status === 404) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "no_appointment" }) }],
            };
          }
          if (!res.ok) throw new Error(`mock-customers ${res.status}`);
          const body = await res.json();
          return {
            content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );
  },
};
