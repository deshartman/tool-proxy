import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

// Subset of the Twilio Message resource the handler already projects.
// Mostly nullable on the wire (Date / errorCode / errorMessage are absent
// for in-flight messages) — schema reflects that rather than over-tightening.
const OutputSchema = {
  sid: z.string().describe("Message SID."),
  status: z.string().describe("Current Twilio Message status."),
  to: z.string().nullable().describe("Recipient address (E.164 / whatsapp:E.164)."),
  from: z.string().nullable().describe("Sender address (E.164 / whatsapp:E.164)."),
  body: z.string().nullable().describe("Message body."),
  dateSent: z.unknown().describe("Twilio SDK Date or null when unsent."),
  errorCode: z.number().nullable().describe("Twilio error code if delivery failed."),
  errorMessage: z.string().nullable().describe("Twilio error message if delivery failed."),
};

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
          outputSchema: OutputSchema,
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
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        }
      );
    },
  };
}
