import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

type Channel = "sms" | "whatsapp" | "rcs";

const CHANNEL_PREFIX: Record<Channel, string> = {
  sms: "",
  whatsapp: "whatsapp:",
  rcs: "rcs:",
};

function defaultFrom(channel: Channel): string | undefined {
  if (channel === "whatsapp") return process.env.TWILIO_WHATSAPP_FROM;
  if (channel === "rcs") return process.env.TWILIO_RCS_AGENT;
  return process.env.TWILIO_FROM_NUMBER;
}

export const messagesCreate: Tool = {
  name: "messages_create",
  register(server) {
    server.registerTool(
      "messages_create",
      {
        description:
          "Send a message via SMS, WhatsApp, or RCS. The connector prepends the channel prefix to to/from. For templated WhatsApp/RCS sends, set contentSid (and contentVariables for placeholders). INCURS CHARGES.",
        inputSchema: {
          channel: z.enum(["sms", "whatsapp", "rcs"]).describe(
            "Channel selector. 'sms' uses raw E.164. 'whatsapp' prepends whatsapp:. 'rcs' prepends rcs: (from is an agent ID).",
          ),
          to: z.string().describe("E.164 destination number, e.g. +15551234567 (no channel prefix — tool prepends it)"),
          body: z.string().min(1).max(1600).optional().describe("Message body. Optional when contentSid is set."),
          contentSid: z.string().optional().describe("Content template SID (HXxxxx). Required for WhatsApp/RCS templated sends outside the 24h session window."),
          contentVariables: z.record(z.string()).optional().describe("Placeholder values for the content template (string keys)."),
          mediaUrl: z.array(z.string()).optional().describe("Media URLs for MMS/WhatsApp media messages."),
          from: z.string().optional().describe("Override the env-configured sender. (Tool adds the channel prefix.)"),
          messagingServiceSid: z.string().optional().describe("Use a Messaging Service instead of an explicit from. Mutually exclusive with from."),
          statusCallback: z.string().optional().describe("Webhook URL for delivery status updates (https://…)."),
        },
      },
      async ({ channel, to, body, contentSid, contentVariables, mediaUrl, from, messagingServiceSid, statusCallback }) => {
        if (!body && !contentSid) {
          throw new Error("Either body or contentSid must be provided");
        }

        const fromBase = from ?? defaultFrom(channel);
        const messagingService = messagingServiceSid ?? process.env.TWILIO_MESSAGING_SERVICE_SID;
        if (!fromBase && !messagingService) {
          throw new Error(
            "from is required (or set TWILIO_FROM_NUMBER / TWILIO_WHATSAPP_FROM / TWILIO_RCS_AGENT, or pass messagingServiceSid)",
          );
        }

        const prefix = CHANNEL_PREFIX[channel];
        const opts: Record<string, unknown> = { to: `${prefix}${to}` };
        if (fromBase) opts.from = `${prefix}${fromBase}`;
        if (messagingService) opts.messagingServiceSid = messagingService;
        if (body) opts.body = body;
        if (contentSid) opts.contentSid = contentSid;
        if (contentVariables) opts.contentVariables = JSON.stringify(contentVariables);
        if (mediaUrl) opts.mediaUrl = mediaUrl;
        if (statusCallback) opts.statusCallback = statusCallback;

        const client = getTwilioClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = await client.messages.create(opts as any);
        return {
          content: [
            { type: "text", text: `sent sid=${message.sid} status=${message.status} channel=${channel}` },
          ],
        };
      },
    );
  },
};
