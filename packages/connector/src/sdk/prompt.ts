import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// One module per prompt. Each prompt owns its own arg validation + handler
// and registers itself on the server. Mirrors the Tool interface — keep the
// surface tiny so prompt files don't fight a shared generic.
//
// envKeys is optional: list every env var the prompt reads at runtime so the
// connector can aggregate them across an MCP and ask the controller which
// values to fill in via the `creds-request` frame (see docs/MCP-PROTOCOL.md).
// Same semantic as Tool.envKeys; the SDK's /envkeys endpoint aggregates
// across prompts AND tools.
export interface Prompt {
  name: string;
  envKeys?: string[];
  register(server: McpServer): void;
}
