import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

const OutputSchema = {
  phoneNumber: z.string().describe("Echoed E.164 number."),
  countryCode: z.string().nullable().describe("ISO 3166-1 alpha-2 country code."),
  nationalFormat: z.string().nullable().describe("Number formatted in its national style."),
  valid: z.boolean().describe("True iff Twilio considers the number valid + reachable."),
};

export function lookupsFetch(client: TwilioClient): Tool {
  return {
    name: "lookups_fetch",
    register(server) {
      server.registerTool(
        "lookups_fetch",
        {
          description: "Validates a phone number and returns its country, national format, and whether it is a real, reachable number.",
          inputSchema: {
            phone_number: z.string().describe("E.164 number, e.g. +15551234567"),
          },
          outputSchema: OutputSchema,
        },
        async ({ phone_number }) => {
          const result = await client.lookups.v2.phoneNumbers(phone_number).fetch();
          const summary = {
            phoneNumber: result.phoneNumber,
            countryCode: result.countryCode,
            nationalFormat: result.nationalFormat,
            valid: result.valid,
          };
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        }
      );
    },
  };
}
