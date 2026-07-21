import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Returns the customer's next upcoming appointment keyed by phone. The
// reschedule procedure calls this to find the appointment to move; if there
// is none the procedure short-circuits.
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

// Mirrors mock/customers/calendar.ts Appointment shape. Reschedule
// procedures project these fields directly (e.g. {{ get_appointment.start }}
// to quote the old slot back to the customer). Error envelope
// ({ error: "no_appointment" }) goes via content[] only — see plan rule #5.
const OutputSchema = {
  appointmentId: z.string().describe("Stable appointment identifier (apt_<hex>)."),
  customerPhone: z.string().describe("Customer's phone in E.164."),
  customerName: z.string().describe("Customer's given name."),
  agentName: z.string().describe("Assigned technician's name."),
  start: z.string().describe("Slot start time, ISO 8601 UTC."),
  end: z.string().describe("Slot end time, start + 1h."),
  status: z.enum(["scheduled", "rescheduled", "cancelled"]).describe("Appointment status."),
  rescheduledAt: z.string().optional().describe("If status='rescheduled', when the move was logged."),
  rescheduledFrom: z.string().optional().describe("If status='rescheduled', the original start time."),
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

export const getAppointment: Tool = {
  name: "get_appointment",
  register(server) {
    server.registerTool(
      "get_appointment",
      {
        title: "CRM Get Appointment",
        description:
          "Returns the customer's next upcoming appointment (appointmentId, agentName, " +
          "start, end, status) keyed by phone. Returns { error: 'no_appointment' } when " +
          "the customer has no upcoming bookings.",
        inputSchema: {
          phone: z
            .string()
            .describe("Customer phone number, E.164 format (e.g. +15551239999)."),
        },
        outputSchema: OutputSchema,
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
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: "no_appointment" }) }],
            };
          }
          if (!res.ok) throw new Error(`mock-customers ${res.status}`);
          const body = await res.json() as AppointmentResponse;
          return {
            structuredContent: body,
            content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );
  },
};
