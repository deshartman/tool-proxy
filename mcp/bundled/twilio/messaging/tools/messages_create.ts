import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

type Channel = "sms" | "whatsapp" | "rcs";

const CHANNEL_PREFIX: Record<Channel, string> = {
  sms: "",
  whatsapp: "whatsapp:",
  rcs: "rcs:",
};

// Conservative subset of the Twilio Message resource — the fields a
// procedure most commonly references after a send (sid for tracking,
// status for early-state visibility, channel echo for branching).
const OutputSchema = {
  sid: z.string().describe("Message SID (SM/MM prefix)."),
  status: z.string().describe("Twilio Message status, e.g. 'queued', 'sent', 'delivered'."),
  channel: z.enum(["sms", "whatsapp", "rcs"]).describe("Echoed channel selector."),
};

export function messagesCreate(client: TwilioClient): Tool {
  return {
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
            contentVariables: z.record(z.string(), z.string()).optional().describe("Placeholder values for the content template (string keys)."),
            mediaUrl: z.array(z.string()).optional().describe("Media URLs for MMS/WhatsApp media messages."),
            from: z.string().optional().describe("Sender. For sms: E.164 number. For whatsapp: E.164 number on a registered WhatsApp sender. For rcs: agent ID. Tool adds the channel prefix. Either from or messagingServiceSid must be provided."),
            messagingServiceSid: z.string().optional().describe("Use a Messaging Service instead of an explicit from. Mutually exclusive with from."),
            statusCallback: z.string().optional().describe(
              "Webhook URL for delivery status updates (https://…). Leave unset and pass receiveStatusCallbacks=true to use the connector-managed default URL.",
            ),
            receiveStatusCallbacks: z.boolean().optional().describe(
              "When true and statusCallback is unset, route Twilio's delivery status updates back through the connector's webhook ingress (visible in the inspector and any onStatusCallback listener).",
            ),
          },
          outputSchema: OutputSchema,
        },
        async ({ channel, to, body, contentSid, contentVariables, mediaUrl, from, messagingServiceSid, statusCallback, receiveStatusCallbacks }) => {
          if (!body && !contentSid) {
            throw new Error("Either body or contentSid must be provided");
          }

          if (!from && !messagingServiceSid) {
            throw new Error("Either from or messagingServiceSid must be provided");
          }

          const prefix = CHANNEL_PREFIX[channel];
          const opts: Record<string, unknown> = { to: `${prefix}${to}` };
          if (from) opts.from = `${prefix}${from}`;
          if (messagingServiceSid) opts.messagingServiceSid = messagingServiceSid;
          if (body) opts.body = body;
          if (contentSid) opts.contentSid = contentSid;
          if (contentVariables) opts.contentVariables = JSON.stringify(contentVariables);
          if (mediaUrl) opts.mediaUrl = mediaUrl;
          const resolvedCallback = statusCallback ?? (receiveStatusCallbacks ? await getDefaultStatusCallback() : undefined);
          if (resolvedCallback) opts.statusCallback = resolvedCallback;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const message = await client.messages.create(opts as any);
          const data = { sid: message.sid, status: message.status, channel };
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
