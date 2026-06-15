import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Validates a candidate slot. Returns whether the slot is free, plus three
// nearby suggestions when it isn't. The procedure also reads daysFromNow /
// isSameDay off the response to drive its edge-case branches (>30d-out
// confirmation, same-day manager-approval escalation).
const MOCK_URL = process.env.MOCK_CUSTOMERS_URL ?? "http://localhost:7400";
const REQ_TIMEOUT_MS = 4000;

export const checkAvailability: Tool = {
  name: "check_availability",
  register(server) {
    server.registerTool(
      "check_availability",
      {
        description:
          "Checks whether a 1-hour slot starting at the given UTC time is free for the " +
          "assigned technician. Returns { available, reason?, daysFromNow, isSameDay, " +
          "technician, suggestions[] } — `suggestions` is empty when available, otherwise " +
          "carries 3 nearby free slots (same day first, then subsequent working days).",
        inputSchema: {
          start: z
            .string()
            .describe("Slot start time, ISO 8601 UTC (e.g. 2026-06-22T14:00:00Z)."),
        },
      },
      async ({ start }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${MOCK_URL}/availability?start=${encodeURIComponent(start)}`,
            { signal: ctl.signal },
          );
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
