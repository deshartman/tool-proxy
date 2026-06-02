import type { Tool } from "./types.js";

export const now: Tool = {
  name: "now",
  register(server) {
    server.registerTool(
      "now",
      { description: "Return the server's current time as an ISO 8601 timestamp." },
      async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })
    );
  },
};
