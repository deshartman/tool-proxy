import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";

export const uuid: Tool = {
  name: "uuid",
  register(server) {
    server.registerTool(
      "uuid",
      { description: "Return a freshly-generated random UUID v4." },
      async () => ({ content: [{ type: "text", text: randomUUID() }] })
    );
  },
};
