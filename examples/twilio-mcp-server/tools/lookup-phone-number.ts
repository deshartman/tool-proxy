import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const lookupPhoneNumber: Tool = {
  name: "lookup_phone_number",
  register(server) {
    server.registerTool(
      "lookup_phone_number",
      {
        description: "Twilio Lookup v2: validate an E.164 number and return carrier info. Read-only.",
        inputSchema: {
          phone_number: z.string().describe("E.164 number, e.g. +15551234567"),
        },
      },
      async ({ phone_number }) => {
        const client = getTwilioClient();
        const result = await client.lookups.v2.phoneNumbers(phone_number).fetch();
        const summary = {
          phoneNumber: result.phoneNumber,
          countryCode: result.countryCode,
          nationalFormat: result.nationalFormat,
          valid: result.valid,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }
    );
  },
};
