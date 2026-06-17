import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

export function messagesFetch(client: TwilioClient): Tool {
  return {
    name: "messages_fetch",
    register(server) {
      server.registerTool(
        "messages_fetch",
        {
          description: "Fetches a single message by its SID and returns its status, sender, recipient, body, and any error details.",
          inputSchema: {
            sid: z.string().describe("Message SID, e.g. SMxxxxxxxx or MMxxxxxxxx"),
          },
        },
        async ({ sid }) => {
          const message = await client.messages(sid).fetch();
          const summary = {
            sid: message.sid,
            status: message.status,
            to: message.to,
            from: message.from,
            body: message.body,
            dateSent: message.dateSent,
            errorCode: message.errorCode,
            errorMessage: message.errorMessage,
          };
          return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
        }
      );
    },
  };
}
