import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

const OutputSchema = {
  sid: z.string().describe("Verify Service SID (VAxxxx)."),
  friendlyName: z.string().nullable().describe("Operator-facing label."),
  codeLength: z.number().nullable().describe("Number of digits in the OTP."),
  lookupEnabled: z.boolean().nullable().describe("Whether Lookup pre-checks numbers."),
  skipSmsToLandlines: z.boolean().nullable().describe("Skip SMS to landline-classified numbers."),
  dtmfInputRequired: z.boolean().nullable().describe("Require DTMF input on call channel."),
  ttsName: z.string().nullable().describe("TTS voice name for call channel."),
  psd2Enabled: z.boolean().nullable().describe("PSD2 SCA mode flag."),
};

export function verifyServicesFetch(client: TwilioClient): Tool {
  return {
    name: "verify_services_fetch",
    register(server) {
      server.registerTool(
        "verify_services_fetch",
        {
          title: "Fetch Verify Service",
          description: "Fetches a Verify Service by SID and returns its code length, lookup config, and channel settings.",
          inputSchema: {
            sid: z.string().describe("Verify Service SID (VAxxxx)."),
          },
          outputSchema: OutputSchema,
        },
        async ({ sid }) => {
          const service = await client.verify.v2.services(sid).fetch();
          const summary = {
            sid: service.sid,
            friendlyName: service.friendlyName,
            codeLength: service.codeLength,
            lookupEnabled: service.lookupEnabled,
            skipSmsToLandlines: service.skipSmsToLandlines,
            dtmfInputRequired: service.dtmfInputRequired,
            ttsName: service.ttsName,
            psd2Enabled: service.psd2Enabled,
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
