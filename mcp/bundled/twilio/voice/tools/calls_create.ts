import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

const OutputSchema = {
  sid: z.string().describe("Call SID (CAxxxx) — the handle for subsequent calls_fetch / status events."),
  status: z.string().describe("Initial Twilio Call status, e.g. 'queued', 'initiated', 'ringing'."),
};

export function callsCreate(client: TwilioClient): Tool {
  return {
    name: "calls_create",
    register(server) {
      server.registerTool(
        "calls_create",
        {
          description: "Place an outbound voice call. Provide either inline TwiML (twiml) or a webhook URL (url) that returns TwiML. INCURS CHARGES.",
          inputSchema: {
            to: z.string().describe("E.164 destination, e.g. +15551234567"),
            from: z.string().describe("E.164 caller-ID."),
            twiml: z.string().optional().describe("Inline TwiML, e.g. <Response><Say>Hello</Say></Response>"),
            url: z.string().optional().describe("Webhook URL that returns TwiML when Twilio dials the call (https://…)."),
            statusCallback: z.string().optional().describe("Webhook URL for call lifecycle status updates (https://…)."),
          },
          outputSchema: OutputSchema,
        },
        async ({ to, from, twiml, url, statusCallback }) => {
          if (!twiml && !url) throw new Error("Provide either twiml or url");
          if (twiml && url) throw new Error("twiml and url are mutually exclusive");

          const opts: Record<string, unknown> = { to, from };
          if (twiml) opts.twiml = twiml;
          if (url) opts.url = url;
          if (statusCallback) opts.statusCallback = statusCallback;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const call = await client.calls.create(opts as any);
          const data = { sid: call.sid, status: call.status };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `dialed sid=${data.sid} status=${data.status}` }],
          };
        },
      );
    },
  };
}
