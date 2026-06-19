import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

type Recipient = { email: string };

function toRecipients(input: string | string[]): Recipient[] {
  return (Array.isArray(input) ? input : [input]).map((email) => ({ email }));
}

const OutputSchema = {
  messageId: z.string().describe("SendGrid x-message-id header — the handle for email_fetch / email_search."),
  statusCode: z.number().describe("HTTP status code from /v3/mail/send (typically 202)."),
};

export function emailSend(getClient: SendGridClientProvider): Tool {
  return {
    name: "email_send",
    register(server) {
      server.registerTool(
        "email_send",
        {
          description:
            "Send an email via SendGrid. Supports plain/HTML body or a dynamic template (templateId, prefix d-…) with placeholder data, plus optional cc/bcc and base64 attachments. INCURS CHARGES.",
          inputSchema: {
            to: z
              .union([z.string(), z.array(z.string())])
              .describe("Recipient email address(es). Single string or array."),
            from: z
              .string()
              .optional()
              .describe("Sender email. Falls back to SENDGRID_FROM_EMAIL. Must be a verified sender."),
            subject: z
              .string()
              .optional()
              .describe("Subject line. Optional when templateId is set (template supplies it)."),
            text: z.string().optional().describe("Plain-text body."),
            html: z.string().optional().describe("HTML body."),
            templateId: z
              .string()
              .optional()
              .describe("Dynamic template ID, e.g. d-xxxxxxxx. Mutually exclusive with subject/text/html."),
            dynamicTemplateData: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Placeholder data for the dynamic template (used with templateId)."),
            cc: z.array(z.string()).optional().describe("CC recipients."),
            bcc: z.array(z.string()).optional().describe("BCC recipients."),
            attachments: z
              .array(
                z.object({
                  filename: z.string().describe("Filename shown to the recipient."),
                  content: z.string().describe("Base64-encoded file contents."),
                  type: z.string().optional().describe("MIME type, e.g. application/pdf. Defaults to application/octet-stream."),
                  disposition: z
                    .enum(["attachment", "inline"])
                    .optional()
                    .describe("attachment (default) or inline (referenced via Content-ID)."),
                }),
              )
              .optional()
              .describe("Optional file attachments. Each content field must be base64-encoded."),
          },
          outputSchema: OutputSchema,
        },
        async ({ to, from, subject, text, html, templateId, dynamicTemplateData, cc, bcc, attachments }) => {
          if (!templateId && !text && !html) {
            throw new Error("Provide text, html, or templateId");
          }
          if (!templateId && !subject) {
            throw new Error("subject is required unless templateId is set");
          }

          const fromEmail = from ?? process.env.SENDGRID_FROM_EMAIL;
          if (!fromEmail) {
            throw new Error("from is required (or set SENDGRID_FROM_EMAIL)");
          }

          const personalization: Record<string, unknown> = { to: toRecipients(to) };
          if (cc?.length) personalization.cc = toRecipients(cc);
          if (bcc?.length) personalization.bcc = toRecipients(bcc);
          if (dynamicTemplateData) personalization.dynamic_template_data = dynamicTemplateData;

          const body: Record<string, unknown> = {
            personalizations: [personalization],
            from: { email: fromEmail },
          };
          if (subject) body.subject = subject;
          if (templateId) body.template_id = templateId;

          const content: Array<{ type: string; value: string }> = [];
          if (text) content.push({ type: "text/plain", value: text });
          if (html) content.push({ type: "text/html", value: html });
          if (content.length) body.content = content;

          if (attachments?.length) {
            body.attachments = attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              type: attachment.type ?? "application/octet-stream",
              disposition: attachment.disposition ?? "attachment",
            }));
          }

          const client = getClient();
          const [response] = await client.request({
            method: "POST",
            url: "/v3/mail/send",
            body,
          });
          const messageId = response.headers["x-message-id"] ?? "(no x-message-id header)";
          const data = { messageId, statusCode: response.statusCode };
          return {
            structuredContent: data,
            content: [
              { type: "text", text: `sent x-message-id=${data.messageId} status=${data.statusCode}` },
            ],
          };
        },
      );
    },
  };
}
