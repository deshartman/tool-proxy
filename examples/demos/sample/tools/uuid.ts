import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { recordUuid } from "../resources/uuids-recent.js";

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
        title: "Sample Generate UUID",
        description: "Return a freshly-generated random UUID v4.",
        outputSchema: OutputSchema,
      },
      async () => {
        const data = { value: randomUUID() };
        recordUuid(data.value);
        return {
          structuredContent: data,
          content: [{ type: "text", text: data.value }],
        };
      },
    );
  },
};
