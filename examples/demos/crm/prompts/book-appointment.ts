import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

// Walks the caller-facing agent through the booking / reschedule flow.
// check_availability accepts an omitted `start` (defaults to current UTC
// time) as a permissive fallback, so the prompt frames step 1 as best-
// practice rather than mandatory — gather a caller-supplied time when you
// can, fall back otherwise. The >30-day and same-day branches mirror the
// edge-case notes at the top of tools/check-availability.ts.
export const bookAppointment: Prompt = {
  name: "book_appointment",
  register(server) {
    server.registerPrompt(
      "book_appointment",
      {
        description:
          "Walks the model through booking or rescheduling an appointment: gather a slot from the caller, check availability, then update the appointment.",
        argsSchema: {
          callerPhone: z
            .string()
            .describe("Caller's E.164 phone (e.g. +15551239999). Usually channel_from off the session envelope."),
        },
      },
      ({ callerPhone }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `You are helping caller ${callerPhone} book or reschedule an appointment. Follow this sequence — gathering a caller-supplied time in step 1 gives you the best experience.`,
                "",
                "  1. Ask the caller for a preferred date and time in their own phrasing (e.g. 'Tuesday at 2pm'). Convert to ISO 8601 UTC yourself; do not ask the caller to phrase it that way.",
                "  2. Call check_availability({ start: <UTC-timestamp> }) using the value from step 1. `start` is optional — if omitted, the tool falls back to the current UTC time, which usually returns available=false with suggestions[]. That fallback is a safety net, not a substitute for step 1.",
                "  3. If available=true, keep the slot. If available=false, read the top `suggestions[]` back to the caller as options and repeat step 2 with the one they pick.",
                `  4. Call get_appointment({ phone: "${callerPhone}" }) to check whether the caller already has an appointment.`,
                "  5a. If get_appointment returned an appointment, call update_appointment({ appointmentId, newStart: <confirmed-UTC> }) to reschedule it — appointmentId must come from that get_appointment response, never guessed or constructed.",
                `  5b. If get_appointment returned { error: "no_appointment" }, call create_appointment({ customerPhone: "${callerPhone}", start: <confirmed-UTC> }) to book a new one instead — do not call update_appointment without a real appointmentId.`,
                "",
                "Edge cases (from the check_availability response):",
                "  - daysFromNow > 30 — read the date back to the caller and get explicit confirmation before step 5.",
                "  - isSameDay=true — same-day changes need manager approval. Call notify_agent({ appointmentId, message }) after step 5 with a body like 'Same-day reschedule: <caller> moved to <newStart>'.",
                "  - reason='outside_working_hours' — tell the caller the slot is outside business hours and ask them to pick a different time. Do not guess a new time yourself.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  },
};

export default bookAppointment;
