import type { Prompt } from "@mcp-shim/connector/sdk";

export const lookupsOverview: Prompt = {
  name: "lookups_overview",
  register(server) {
    server.registerPrompt(
      "lookups_overview",
      {
        description: "When to use lookups_fetch — phone number validation, format normalization, country detection.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Twilio Lookup v2 — single-tool service.\n\n` +
                `lookups_fetch({ phone_number }) validates a phone number and returns its E.164 form, country, national format, and whether the number is real and reachable.\n\n` +
                `Call this BEFORE sending an SMS, placing a call, or starting a Verify flow on any user-supplied number. It's free and idempotent. The cost of one lookup is negligible compared to a failed send to a malformed number.\n\n` +
                `Accept any input format — Lookup normalizes "+1 415 555 1212", "(415) 555-1212", and "4155551212" to the same E.164 result.`,
            },
          },
        ],
      }),
    );
  },
};
