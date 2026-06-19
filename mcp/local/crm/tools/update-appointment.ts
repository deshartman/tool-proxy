import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Moves an existing appointment to a new start time. The mock service runs
// the same validation `check_availability` does (working hours, not in the
// past, slot not double-booked) and returns one of:
//   - 200 with the updated appointment
//   - 409 { error: "slot_taken" | "outside_working_hours" | "in_the_past" | "not_found" }
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

// Same shape as get-appointment's success body — the mock service returns
// the updated Appointment record. Error envelopes (HTTP 409) flow through
// content[] only per plan rule #5; structuredContent fires only on the
// 200 success path so the SDK doesn't validate the error shape against
// this success schema.
const OutputSchema = {
  appointmentId: z.string().describe("Stable appointment identifier."),
  customerPhone: z.string().describe("Customer's phone in E.164."),
  customerName: z.string().describe("Customer's given name."),
  agentName: z.string().describe("Assigned technician's name."),
  start: z.string().describe("Updated slot start time, ISO 8601 UTC."),
  end: z.string().describe("Updated slot end time."),
  status: z.enum(["scheduled", "rescheduled", "cancelled"]).describe("Always 'rescheduled' on the success path here."),
  rescheduledAt: z.string().optional().describe("Timestamp the reschedule was logged, ISO 8601 UTC."),
  rescheduledFrom: z.string().optional().describe("The previous start time, ISO 8601 UTC."),
};

interface AppointmentResponse {
  appointmentId: string;
  customerPhone: string;
  customerName: string;
  agentName: string;
  start: string;
  end: string;
  status: "scheduled" | "rescheduled" | "cancelled";
  rescheduledAt?: string;
  rescheduledFrom?: string;
}

interface ErrorBody { error?: string }

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
        outputSchema: OutputSchema,
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
          const body = await res.json() as AppointmentResponse | ErrorBody;
          // Only the 200 success path carries structuredContent; the 409
          // error envelopes ({ error: "..." }) would not match the success
          // schema and the SDK validates structuredContent against the
          // declared shape regardless of an isError flag.
          if (res.ok) {
            const success = body as AppointmentResponse;
            return {
              structuredContent: success,
              content: [{ type: "text", text: JSON.stringify(success, null, 2) }],
            };
          }
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
