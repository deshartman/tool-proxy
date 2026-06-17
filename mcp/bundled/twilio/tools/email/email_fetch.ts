import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SendGridClientProvider } from "../../sendgrid-client.js";

export function emailFetch(getClient: SendGridClientProvider): Tool {
  return {
    name: "email_fetch",
    register(server) {
      server.registerTool(
        "email_fetch",
        {
          description:
            "Fetches the full delivery/event timeline for a single SendGrid message id (opens, clicks, bounces, deferrals). Requires a SendGrid Pro plan or above (Email Activity API).",
          inputSchema: {
            msgId: z.string().describe("SendGrid message id, returned by /v3/messages or as x-message-id from email_send."),
          },
        },
        async ({ msgId }) => {
          const client = getClient();
          const [, body] = await client.request({
            method: "GET",
            url: `/v3/messages/${encodeURIComponent(msgId)}`,
          });
          return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
        },
      );
    },
  };
}
