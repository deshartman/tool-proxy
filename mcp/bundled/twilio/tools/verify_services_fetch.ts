import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const verifyServicesFetch: Tool = {
  name: "verify_services_fetch",
  register(server) {
    server.registerTool(
      "verify_services_fetch",
      {
        description: "Fetches a Verify Service by SID and returns its code length, lookup config, and channel settings.",
        inputSchema: {
          sid: z.string().optional().describe("Verify Service SID (VAxxxx). Defaults to TWILIO_VERIFY_SERVICE_SID."),
        },
      },
      async ({ sid }) => {
        const client = getTwilioClient();
        const targetSid = sid ?? process.env.TWILIO_VERIFY_SERVICE_SID;
        if (!targetSid) throw new Error("sid is required (or set TWILIO_VERIFY_SERVICE_SID)");
        const service = await client.verify.v2.services(targetSid).fetch();
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
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    );
  },
};
