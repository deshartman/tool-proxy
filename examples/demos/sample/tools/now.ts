import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";

// Bucket B (single-scalar) per OUTPUT-SCHEMA.md — wrap the lone string in
// { value } so the controller-side projection target has a stable field
// name regardless of tool semantics.
const OutputSchema = {
  value: z.string().describe("Server's current time, ISO 8601 UTC."),
};

export const now: Tool = {
  name: "now",
  register(server) {
    server.registerTool(
      "now",
      {
        title: "Sample Show Current Time",
        description: "Return the server's current time as an ISO 8601 timestamp.",
        outputSchema: OutputSchema,
      },
      async () => {
        const data = { value: new Date().toISOString() };
        return {
          structuredContent: data,
          content: [{ type: "text", text: data.value }],
        };
      },
    );
  },
};
