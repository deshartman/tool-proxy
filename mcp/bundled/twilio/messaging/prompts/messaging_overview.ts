import type { Prompt } from "@mcp-shim/connector/sdk";

export const messagingOverview: Prompt = {
  name: "messaging_overview",
  register(server) {
    server.registerPrompt(
      "messaging_overview",
      {
        description: "Quick reference for which Twilio messaging tool to call in which situation (SMS, WhatsApp, RCS, templates, lookups by SID).",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Twilio messaging — tool selection guide.\n\n` +
                `SEND a message: messages_create. Pick the channel via the channel arg ("sms", "whatsapp", or "rcs"). ` +
                `Provide either from (a Twilio phone number) OR messagingServiceSid (a Messaging Service that handles sender selection, retries, and shortcode failover). ` +
                `For ad-hoc text, set body. For templated WhatsApp / RCS, set contentSid to a Content template SID (HXxxxx) and pass contentVariables; the template handles localization and rich content. ` +
                `INCURS CHARGES per message segment — keep bodies short.\n\n` +
                `LOOK UP a message after sending: messages_fetch with the SID returned from messages_create. Returns delivery status, error code if any, and the body.\n\n` +
                `INSPECT a Messaging Service config: messaging_services_fetch with the service SID (MGxxxx). Returns the sender pool, fallback URL, and feature flags. Read-only — does not place a message.\n\n` +
                `INSPECT a Content template: content_templates_fetch with the template SID (HXxxxx). Returns the variables it expects and its friendly name. Use this before passing a template's SID to messages_create.contentSid.\n\n` +
                `If you don't know whether a phone number is real or what country it belongs to, call lookups_fetch first — it's free and idempotent.`,
            },
          },
        ],
      }),
    );
  },
};
