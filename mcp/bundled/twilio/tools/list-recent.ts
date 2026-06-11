import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const listRecent: Tool = {
  name: "list_recent",
  register(server) {
    server.registerTool(
      "list_recent",
      {
        description: "List the most recent calls or messages on this account.",
        inputSchema: {
          kind: z.enum(["calls", "messages"]),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ kind, limit }) => {
        const client = getTwilioClient();
        const n = limit ?? 10;
        if (kind === "calls") {
          const calls = await client.calls.list({ limit: n });
          const rows = calls.map((c) => ({
            sid: c.sid,
            to: c.to,
            from: c.from,
            status: c.status,
            duration: c.duration,
            startTime: c.startTime,
          }));
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
        }
        const messages = await client.messages.list({ limit: n });
        const rows = messages.map((m) => ({
          sid: m.sid,
          to: m.to,
          from: m.from,
          status: m.status,
          body: m.body,
          dateSent: m.dateSent,
        }));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }
    );
  },
};
