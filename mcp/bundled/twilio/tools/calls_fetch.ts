import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../twilio-client.js";

export const callsFetch: Tool = {
  name: "calls_fetch",
  register(server) {
    server.registerTool(
      "calls_fetch",
      {
        description: "Fetches a single call by SID and returns its status, direction, duration, and timing.",
        inputSchema: {
          sid: z.string().describe("Call SID, e.g. CAxxxxxxxx"),
        },
      },
      async ({ sid }) => {
        const client = getTwilioClient();
        const call = await client.calls(sid).fetch();
        const summary = {
          sid: call.sid,
          status: call.status,
          direction: call.direction,
          to: call.to,
          from: call.from,
          duration: call.duration,
          startTime: call.startTime,
          endTime: call.endTime,
          price: call.price,
          priceUnit: call.priceUnit,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    );
  },
};
