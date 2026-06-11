import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const messagesFetch: Tool = {
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
        const client = getTwilioClient();
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
