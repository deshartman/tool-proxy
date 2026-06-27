import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

// SendGrid /v3/templates returns either a single-template object (with
// versions[]) or a list shape ({ templates: [...] }) depending on whether
// templateId is set. Wrap as `body` so the schema describes what callers
// project against without lying about the polymorphism.
const OutputSchema = {
  body: z.unknown().describe("SendGrid /v3/templates response body. Single template (with versions[]) or { templates: [...] } depending on templateId."),
};

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
          outputSchema: OutputSchema,
        },
        async ({ templateId }) => {
          const client = getClient();
          if (templateId) {
            const [, body] = await client.request({
              method: "GET",
              url: `/v3/templates/${encodeURIComponent(templateId)}`,
            });
            return {
              structuredContent: { body },
              content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
            };
          }
          const [, body] = await client.request({
            method: "GET",
            url: "/v3/templates",
            qs: { generations: "dynamic", page_size: 200 },
          });
          return {
            structuredContent: { body },
            content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
          };
        },
      );
    },
  };
}
