import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// One module per resource. Each resource owns its own URI + read handler
// and registers itself on the server. Templates use the SDK's
// ResourceTemplate type when the URI carries variables — see
// `examples/demos/sample/resources/uuids-recent.ts` for a worked example.
//
// The minimal surface mirrors Tool / Prompt deliberately: tiny interface,
// authors stay close to the SDK's registerResource() so they can use the
// full mime type / metadata vocabulary without re-learning a wrapper.
export interface Resource {
  name: string;
  envKeys?: string[];
  register(server: McpServer): void;
}
