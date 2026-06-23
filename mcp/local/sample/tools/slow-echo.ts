import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Bucket C (demo-only, opaque body) per OUTPUT-SCHEMA.md. Schema exists
// purely so the strict-mode validator passes; it isn't a useful projection
// target for any production procedure.
const OutputSchema = {
  message: z.string().describe("Echoed input text."),
  elapsedMs: z.number().describe("Approximate time spent sleeping, ms."),
};

export const slowEcho: Tool = {
  name: "slow_echo",
  register(server) {
    server.registerTool(
      "slow_echo",
      {
        description: "Sleep for sleep_ms (default 6000), then echo text. Use to test tool_timeout_ms.",
        inputSchema: {
          text: z.string(),
          sleep_ms: z.number().optional(),
        },
        outputSchema: OutputSchema,
      },
      async ({ text, sleep_ms }) => {
        const slept = sleep_ms ?? 6000;
        await new Promise((r) => setTimeout(r, slept));
        const data = { message: text, elapsedMs: slept };
        return {
          structuredContent: data,
          content: [{ type: "text", text }],
        };
      },
    );
  },
};
