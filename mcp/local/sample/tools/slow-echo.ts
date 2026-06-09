import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

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
      },
      async ({ text, sleep_ms }) => {
        await new Promise((r) => setTimeout(r, sleep_ms ?? 6000));
        return { content: [{ type: "text", text }] };
      }
    );
  },
};
