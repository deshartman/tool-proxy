import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../../twilio-client.js";

export const messagingServicesFetch: Tool = {
  name: "messaging_services_fetch",
  register(server) {
    server.registerTool(
      "messaging_services_fetch",
      {
        description: "Fetches a Messaging Service by SID and returns its sender pool config, fallback URL, and feature flags.",
        inputSchema: {
          sid: z.string().describe("Messaging Service SID, e.g. MGxxxxxxxx").optional(),
        },
      },
      async ({ sid }) => {
        const client = getTwilioClient();
        const targetSid = sid ?? process.env.TWILIO_MESSAGING_SERVICE_SID;
        if (!targetSid) {
          throw new Error("sid is required (or set TWILIO_MESSAGING_SERVICE_SID)");
        }
        const service = await client.messaging.v1.services(targetSid).fetch();
        const summary = {
          sid: service.sid,
          friendlyName: service.friendlyName,
          inboundRequestUrl: service.inboundRequestUrl,
          fallbackUrl: service.fallbackUrl,
          statusCallback: service.statusCallback,
          stickySender: service.stickySender,
          smartEncoding: service.smartEncoding,
          scanMessageContent: service.scanMessageContent,
          useInboundWebhookOnNumber: service.useInboundWebhookOnNumber,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    );
  },
};
