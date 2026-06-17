import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

export function emailTemplatesFetch(getClient: SendGridClientProvider): Tool {
  return {
    name: "email_templates_fetch",
    register(server) {
      server.registerTool(
        "email_templates_fetch",
        {
          description:
            "Lists SendGrid dynamic templates, or fetches one template (with all versions and HTML/subject) when templateId is set. Use the templateId (d-xxxx) with email_send.templateId for templated sends.",
          inputSchema: {
            templateId: z
              .string()
              .optional()
              .describe("Dynamic template id, e.g. d-xxxxxxxx. Omit to list all dynamic templates."),
          },
        },
        async ({ templateId }) => {
          const client = getClient();
          if (templateId) {
            const [, body] = await client.request({
              method: "GET",
              url: `/v3/templates/${encodeURIComponent(templateId)}`,
            });
            return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
          }
          const [, body] = await client.request({
            method: "GET",
            url: "/v3/templates",
            qs: { generations: "dynamic", page_size: 200 },
          });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        },
      );
    },
  };
}
