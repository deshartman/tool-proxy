import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const callsCreate: Tool = {
  name: "calls_create",
  register(server) {
    server.registerTool(
      "calls_create",
      {
        description: "Place an outbound voice call. Provide either inline TwiML (twiml) or a webhook URL (url) that returns TwiML. INCURS CHARGES.",
        inputSchema: {
          to: z.string().describe("E.164 destination, e.g. +15551234567"),
          from: z.string().optional().describe("E.164 caller-ID. Defaults to TWILIO_FROM_NUMBER."),
          twiml: z.string().optional().describe("Inline TwiML, e.g. <Response><Say>Hello</Say></Response>"),
          url: z.string().optional().describe("Webhook URL that returns TwiML when Twilio dials the call (https://…)."),
          statusCallback: z.string().optional().describe("Webhook URL for call lifecycle status updates (https://…)."),
        },
      },
      async ({ to, from, twiml, url, statusCallback }) => {
        const client = getTwilioClient();
        const fromNumber = from ?? process.env.TWILIO_FROM_NUMBER;
        if (!fromNumber) throw new Error("from is required (or set TWILIO_FROM_NUMBER)");
        if (!twiml && !url) throw new Error("Provide either twiml or url");
        if (twiml && url) throw new Error("twiml and url are mutually exclusive");

        const opts: Record<string, unknown> = { to, from: fromNumber };
        if (twiml) opts.twiml = twiml;
        if (url) opts.url = url;
        if (statusCallback) opts.statusCallback = statusCallback;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const call = await client.calls.create(opts as any);
        return {
          content: [
            { type: "text", text: `dialed sid=${call.sid} status=${call.status}` },
          ],
        };
      },
    );
  },
};
