import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// One module per tool. The shape mirrors what McpServer.registerTool wants:
// a name, a {description, inputSchema?} definition object, and an async handler.
// Keeping it generic means each tool file owns its own zod-typed args without
// fighting a shared interface.
export interface Tool {
  name: string;
  register(server: McpServer): void;
}
