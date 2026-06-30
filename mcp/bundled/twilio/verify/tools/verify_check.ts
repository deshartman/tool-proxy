import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

const OutputSchema = {
  sid: z.string().describe("Verification check SID."),
  status: z.string().describe("Outcome: 'approved' / 'pending' / 'canceled'."),
  valid: z.boolean().describe("True iff the submitted OTP matched (status='approved')."),
  to: z.string().nullable().describe("Echoed recipient address."),
  channel: z.string().nullable().describe("Channel used by the original verify_send."),
};

export function verifyCheck(client: TwilioClient): Tool {
  return {
    name: "verify_check",
    register(server) {
      server.registerTool(
        "verify_check",
        {
          title: "Check Verification Code (OTP)",
          description: "Validates a one-time verification code (OTP) submitted by the user. Returns status='approved' on success.",
          inputSchema: {
            to: z.string().describe("The same to value used in verify_send (E.164 phone or email)."),
            code: z.string().describe("The OTP the user submitted."),
            serviceSid: z.string().describe("Verify Service SID (VAxxxx)."),
          },
          outputSchema: OutputSchema,
        },
        async ({ to, code, serviceSid }) => {
          const result = await client.verify.v2.services(serviceSid).verificationChecks.create({ to, code });
          const summary = {
            sid: result.sid,
            status: result.status,
            valid: result.valid,
            to: result.to,
            channel: result.channel,
          };
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        },
      );
    },
  };
}
