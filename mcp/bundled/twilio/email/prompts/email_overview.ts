import type { Prompt } from "@mcp-shim/connector/sdk";

export const emailOverview: Prompt = {
  name: "email_overview",
  register(server) {
    server.registerPrompt(
      "email_overview",
      {
        description: "Quick reference for SendGrid email send, delivery lookup, search, and template inspection.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `SendGrid email — tool selection guide.\n\n` +
                `SEND: email_send({ to, from, subject?, text?, html?, templateId?, ... }). ` +
                `For templated email, set templateId (the SendGrid dynamic template ID) and pass dynamic_template_data — subject + body come from the template. ` +
                `For ad-hoc email, omit templateId and supply subject + text and/or html directly. INCURS CHARGES (SendGrid plan tier dependent).\n\n` +
                `LOOK UP delivery + event timeline after sending: email_fetch({ msgId }). Returns the bounce/open/click/dropped events Twilio's SendGrid backend recorded. Requires a SendGrid Pro+ plan — the Event API isn't exposed on lower tiers. Free.\n\n` +
                `SEARCH recent messages: email_search({ query?, ... }). Useful when you have a recipient or subject substring but not the msgId. Same Pro+ requirement.\n\n` +
                `INSPECT a dynamic template: email_templates_fetch({ templateId? }). Returns the template's variables and active version. Read-only.\n\n` +
                `The from address MUST be a verified sender on the SendGrid account. Sending from an unverified address returns a 403.`,
            },
          },
        ],
      }),
    );
  },
};
