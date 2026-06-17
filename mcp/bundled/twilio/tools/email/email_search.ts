import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

export function emailSearch(getClient: SendGridClientProvider): Tool {
  return {
    name: "email_search",
    register(server) {
      server.registerTool(
        "email_search",
        {
          description:
            'Search SendGrid message activity. The query is a SendGrid filter expression with double-quoted values, e.g. \'to_email="user@example.com" AND status="delivered"\'. Requires a SendGrid Pro plan or above (Email Activity API).',
          inputSchema: {
            query: z
              .string()
              .describe(
                'SendGrid filter expression. Examples: to_email="x@y.com", status="bounce", last_event_time BETWEEN TIMESTAMP "2026-01-01T00:00:00Z" AND TIMESTAMP "2026-01-02T00:00:00Z". Combine with AND/OR.',
              ),
            limit: z
              .number()
              .int()
              .min(1)
              .max(1000)
              .optional()
              .describe("Max results to return (1-1000). Default 10."),
          },
        },
        async ({ query, limit }) => {
          const client = getClient();
          const [, body] = await client.request({
            method: "GET",
            url: "/v3/messages",
            qs: { query, limit: limit ?? 10 },
          });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        },
      );
    },
  };
}
