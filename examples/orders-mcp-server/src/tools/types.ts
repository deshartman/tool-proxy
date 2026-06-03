import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface Tool {
  name: string;
  register(server: McpServer): void;
}
