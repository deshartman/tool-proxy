import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

// Fields the handler projects today. duration is a string in the SDK
// (Twilio returns it as a stringified integer); startTime/endTime are
// SDK Date instances. Schema treats both as nullable strings/unknown so
// procedures get correctly-typed projection without us misclaiming Date.
const OutputSchema = {
  sid: z.string().describe("Call SID."),
  status: z.string().describe("Twilio Call status."),
  direction: z.string().nullable().describe("'inbound' / 'outbound-api' / 'outbound-dial' / 'outbound-reply'."),
  to: z.string().nullable().describe("Destination address."),
  from: z.string().nullable().describe("Caller-ID."),
  duration: z.string().nullable().describe("Duration in seconds, stringified by the SDK."),
  startTime: z.unknown().describe("Twilio SDK Date or null when not yet started."),
  endTime: z.unknown().describe("Twilio SDK Date or null when in-flight."),
  price: z.string().nullable().describe("Call price in priceUnit, stringified by the SDK."),
  priceUnit: z.string().nullable().describe("ISO 4217 currency code for `price`."),
};

export function callsFetch(client: TwilioClient): Tool {
  return {
    name: "calls_fetch",
    register(server) {
      server.registerTool(
        "calls_fetch",
        {
          title: "Fetch Call Status",
          description: "Fetches a single call by SID and returns its status, direction, duration, and timing.",
          inputSchema: {
            sid: z.string().describe("Call SID, e.g. CAxxxxxxxx"),
          },
          outputSchema: OutputSchema,
        },
        async ({ sid }) => {
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
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        },
      );
    },
  };
}
