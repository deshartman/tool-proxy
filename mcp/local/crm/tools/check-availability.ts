import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Validates a candidate slot. Returns whether the slot is free, plus three
// nearby suggestions when it isn't. The procedure also reads daysFromNow /
// isSameDay off the response to drive its edge-case branches (>30d-out
// confirmation, same-day manager-approval escalation).
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

// Mirrors mock/customers/calendar.ts AvailabilityResult. The mock service
// always returns 200 with this body shape — `available` distinguishes the
// success vs. unavailable cases, but neither is an "error" in the MCP
// sense, so structuredContent is populated for both.
const OutputSchema = {
  requested: z.string().describe("Echoed input — the slot start time, ISO 8601 UTC."),
  available: z.boolean().describe("True if the slot is bookable as-is."),
  reason: z
    .enum(["outside_working_hours", "in_the_past", "slot_taken"])
    .optional()
    .describe("Reason the slot is unavailable; absent when available=true."),
  daysFromNow: z.number().describe("Whole UTC days from today to the requested slot. 0 = today."),
  isSameDay: z.boolean().describe("Convenience flag: daysFromNow === 0."),
  technician: z.string().describe("Technician the availability is computed for."),
  suggestions: z.array(z.string()).describe("Up to 3 nearby free slot start times (ISO 8601 UTC); empty when available=true."),
};

interface AvailabilityResponse {
  requested: string;
  available: boolean;
  reason?: "outside_working_hours" | "in_the_past" | "slot_taken";
  daysFromNow: number;
  isSameDay: boolean;
  technician: string;
  suggestions: string[];
}

export const checkAvailability: Tool = {
  name: "check_availability",
  register(server) {
    server.registerTool(
      "check_availability",
      {
        title: "CRM Check Availability",
        description:
          "Checks whether a 1-hour slot starting at the given UTC time is free for the " +
          "assigned technician. Returns { available, reason?, daysFromNow, isSameDay, " +
          "technician, suggestions[] } — `suggestions` is empty when available, otherwise " +
          "carries 3 nearby free slots (same day first, then subsequent working days). " +
          "If `start` is omitted, the tool checks the current UTC time — expect " +
          "available=false with suggestions[] most of the time in that case.",
        inputSchema: {
          start: z
            .string()
            .optional()
            .describe("Optional slot start time, ISO 8601 UTC (e.g. 2026-06-22T14:00:00Z). Defaults to the current UTC time if omitted."),
        },
        outputSchema: OutputSchema,
      },
      async ({ start }) => {
        const startTime = start ?? new Date().toISOString();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${MOCK_URL}/availability?start=${encodeURIComponent(startTime)}`,
            { signal: ctl.signal },
          );
          if (!res.ok) throw new Error(`mock-customers ${res.status}`);
          const body = await res.json() as AvailabilityResponse;
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
