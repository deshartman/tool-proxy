import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Bucket B (single-scalar) per OUTPUT-SCHEMA.md.
const OutputSchema = {
  value: z.string().describe("A freshly-generated random UUID v4."),
};

export const uuid: Tool = {
  name: "uuid",
  register(server) {
    server.registerTool(
      "uuid",
      {
        description: "Return a freshly-generated random UUID v4.",
        outputSchema: OutputSchema,
      },
      async () => {
        const data = { value: randomUUID() };
        return {
          structuredContent: data,
          content: [{ type: "text", text: data.value }],
        };
      },
    );
  },
};
