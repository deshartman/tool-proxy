import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { MOCK_URL, REQ_TIMEOUT_MS } from "../lib/backend.js";

// Operator-facing write tool. Books an appointment for an existing
// customer at a given start time. Backed by the mock-backend's
// POST /appointments endpoint.
//
// The mock enforces the same working-hours model check_availability
// uses (Mon-Fri, 09:00-16:00 UTC, on the hour) and the same "single
// technician, one appointment per slot" rule. Failures return one of
// { no_customer | slot_taken | outside_working_hours | in_the_past }.

// Success-path shape mirrors get_appointment's success body — the mock
// returns the freshly-inserted Appointment record. Error envelopes flow
// through content[] only (isError=true) per plan rule #5.
const OutputSchema = {
  appointmentId: z.string().describe("Stable appointment identifier (apt_<hex>)."),
  customerPhone: z.string().describe("Customer's phone in E.164."),
  customerName: z.string().describe("Customer's given name."),
  agentName: z.string().describe("Assigned technician's name."),
  start: z.string().describe("Slot start time, ISO 8601 UTC."),
  end: z.string().describe("Slot end time, start + 1h."),
  status: z.enum(["scheduled", "rescheduled", "cancelled"]).describe("Always 'scheduled' on the success path."),
};

interface AppointmentResponse {
  appointmentId: string;
  customerPhone: string;
  customerName: string;
  agentName: string;
  start: string;
  end: string;
  status: "scheduled" | "rescheduled" | "cancelled";
}

export const createAppointment: Tool = {
  name: "create_appointment",
  envKeys: ["MOCK_CUSTOMERS_URL"],
  register(server) {
    server.registerTool(
      "create_appointment",
      {
        title: "CRM Create Appointment",
        description:
          "Book a 1-hour appointment slot for an existing customer. `start` must be Mon-Fri " +
          "09:00-16:00 UTC on the hour. Customer must already exist (create via create_customer " +
          "first). Returns the Appointment on success, or { error } for `no_customer` (404), " +
          "`slot_taken` / `outside_working_hours` / `in_the_past` (409).",
        inputSchema: {
          customerPhone: z
            .string()
            .describe("Customer's phone in E.164 (e.g. +15551239999). Must match an existing customer."),
          start: z
            .string()
            .describe("Slot start time, ISO 8601 UTC (e.g. 2026-08-04T14:00:00Z). Mon-Fri, on the hour, 09:00-16:00 UTC."),
        },
        outputSchema: OutputSchema,
      },
      async ({ customerPhone, start }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(`${MOCK_URL}/appointments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerPhone, start }),
            signal: ctl.signal,
          });
          const body = await res.json() as AppointmentResponse | { error: string };
          if (!res.ok) {
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(body) }],
            };
          }
          const success = body as AppointmentResponse;
          return {
            structuredContent: success,
            content: [{ type: "text", text: JSON.stringify(success, null, 2) }],
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );
  },
};

export default createAppointment;
