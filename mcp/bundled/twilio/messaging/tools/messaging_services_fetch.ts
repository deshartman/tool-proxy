import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

// Subset of the Messaging Service resource the handler projects today —
// the fields procedure authors most often reference (the routing knobs
// and the configured webhook URLs).
const OutputSchema = {
  sid: z.string().describe("Messaging Service SID."),
  friendlyName: z.string().nullable().describe("Operator-facing label."),
  inboundRequestUrl: z.string().nullable().describe("Inbound webhook URL."),
  fallbackUrl: z.string().nullable().describe("Fallback URL when inbound fails."),
  statusCallback: z.string().nullable().describe("Status-callback URL for outbound messages."),
  stickySender: z.boolean().nullable().describe("Sticky sender feature flag."),
  smartEncoding: z.boolean().nullable().describe("Smart encoding feature flag."),
  scanMessageContent: z.string().nullable().describe("Scanner mode — Twilio enum (inherit/disable/etc.)."),
  useInboundWebhookOnNumber: z.boolean().nullable().describe("Per-number webhook override flag."),
};

export function messagingServicesFetch(client: TwilioClient): Tool {
  return {
    name: "messaging_services_fetch",
    register(server) {
      server.registerTool(
        "messaging_services_fetch",
        {
          title: "Fetch Messaging Service",
          description: "Fetches a Messaging Service by SID and returns its sender pool config, fallback URL, and feature flags.",
          inputSchema: {
            sid: z.string().describe("Messaging Service SID, e.g. MGxxxxxxxx"),
          },
          outputSchema: OutputSchema,
        },
        async ({ sid }) => {
          const service = await client.messaging.v1.services(sid).fetch();
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
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        },
      );
    },
  };
}
