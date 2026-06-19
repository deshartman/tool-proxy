import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

const OutputSchema = {
  sid: z.string().describe("Verification attempt SID."),
  status: z.string().describe("Twilio Verify status, e.g. 'pending'."),
  channel: z.string().describe("Echoed channel ('sms' / 'call' / 'email' / 'whatsapp')."),
};

export function verifySend(client: TwilioClient): Tool {
  return {
    name: "verify_send",
    register(server) {
      server.registerTool(
        "verify_send",
        {
          description: "Sends a one-time verification code (OTP) to the recipient via the chosen channel. INCURS CHARGES.",
          inputSchema: {
            to: z.string().describe("E.164 phone number for sms/call/whatsapp, or email address for email."),
            channel: z.enum(["sms", "call", "email", "whatsapp"]).describe("Delivery channel for the OTP."),
            serviceSid: z.string().optional().describe("Verify Service SID (VAxxxx). Defaults to TWILIO_VERIFY_SERVICE_SID."),
            locale: z.string().optional().describe("BCP-47 locale, e.g. en-US."),
          },
          outputSchema: OutputSchema,
        },
        async ({ to, channel, serviceSid, locale }) => {
          const targetSid = serviceSid ?? process.env.TWILIO_VERIFY_SERVICE_SID;
          if (!targetSid) throw new Error("serviceSid is required (or set TWILIO_VERIFY_SERVICE_SID)");

          const opts: Record<string, unknown> = { to, channel };
          if (locale) opts.locale = locale;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const verification = await client.verify.v2.services(targetSid).verifications.create(opts as any);
          const data = { sid: verification.sid, status: verification.status, channel: verification.channel };
          return {
            structuredContent: data,
            content: [
              { type: "text", text: `sent sid=${data.sid} status=${data.status} channel=${data.channel}` },
            ],
          };
        },
      );
    },
  };
}
