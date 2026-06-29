import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

// SendGrid /v3/messages/{id} returns a deeply nested event timeline whose
// shape evolves with the API. Wrap the raw body under a `body` field rather
// than over-tightening — procedure authors who need to project specific
// fields can dig in via `body.events[0].event_name` etc.
const OutputSchema = {
  body: z.unknown().describe("SendGrid /v3/messages/{id} response body. See SendGrid Email Activity API docs for the event-timeline shape."),
};

export function emailFetch(getClient: SendGridClientProvider): Tool {
  return {
    name: "email_fetch",
    register(server) {
      server.registerTool(
        "email_fetch",
        {
          title: "Fetch Email Activity",
          description:
            "Fetches the full delivery/event timeline for a single SendGrid message id (opens, clicks, bounces, deferrals). Requires a SendGrid Pro plan or above (Email Activity API).",
          inputSchema: {
            msgId: z.string().describe("SendGrid message id, returned by /v3/messages or as x-message-id from email_send."),
          },
          outputSchema: OutputSchema,
        },
        async ({ msgId }) => {
          const client = getClient();
          const [, body] = await client.request({
            method: "GET",
            url: `/v3/messages/${encodeURIComponent(msgId)}`,
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
