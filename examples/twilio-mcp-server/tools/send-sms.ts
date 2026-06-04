import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const sendSms: Tool = {
  name: "send_sms",
  register(server) {
    server.registerTool(
      "send_sms",
      {
        description: "Send an SMS via Twilio. From defaults to TWILIO_FROM. INCURS CHARGES.",
        inputSchema: {
          to: z.string().describe("E.164 destination number, e.g. +15551234567"),
          body: z.string().min(1).max(1600),
          from: z.string().optional(),
        },
      },
      async ({ to, body, from }) => {
        const client = getTwilioClient();
        const fromNumber = from ?? process.env.TWILIO_FROM;
        if (!fromNumber) throw new Error("from is required (or set TWILIO_FROM)");
        const msg = await client.messages.create({ to, body, from: fromNumber });
        return {
          content: [
            { type: "text", text: `sent sid=${msg.sid} status=${msg.status}` },
          ],
        };
      }
    );
  },
};
