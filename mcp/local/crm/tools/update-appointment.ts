import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Moves an existing appointment to a new start time. The mock service runs
// the same validation `check_availability` does (working hours, not in the
// past, slot not double-booked) and returns one of:
//   - 200 with the updated appointment
//   - 409 { error: "slot_taken" | "outside_working_hours" | "in_the_past" | "not_found" }
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

export const updateAppointment: Tool = {
  name: "update_appointment",
  register(server) {
    server.registerTool(
      "update_appointment",
      {
        description:
          "Reschedules an existing appointment to a new start time. Returns the updated " +
          "appointment on success, or { error: 'slot_taken' | 'outside_working_hours' | " +
          "'in_the_past' | 'not_found' } on failure. Re-call check_availability first if " +
          "the slot was offered more than 15 minutes ago — it may have been taken.",
        inputSchema: {
          appointmentId: z
            .string()
            .describe("Identifier returned by get_appointment (e.g. apt_xxxxxxxxxx)."),
          newStart: z
            .string()
            .describe("New slot start time, ISO 8601 UTC (e.g. 2026-06-22T14:00:00Z)."),
        },
      },
      async ({ appointmentId, newStart }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${MOCK_URL}/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ newStart }),
              signal: ctl.signal,
            },
          );
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
