import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// One module per tool. Each tool owns its own zod-typed args + handler and
// registers itself on the server. Keeping the interface minimal (name +
// register) means tool files don't fight a shared generic.
export interface Tool {
  name: string;
  register(server: McpServer): void;
}
