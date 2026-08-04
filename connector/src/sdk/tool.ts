import type { McpServer } from "@modelcontextprotocol/server";

// One module per tool. Each tool owns its own zod-typed args + handler and
// registers itself on the server. Keeping the interface minimal (name +
// register) means tool files don't fight a shared generic.
//
// envKeys is optional: list every env var the tool reads at runtime so the
// connector can aggregate them across an MCP and ask the controller which
// values to fill in via the `creds-request` frame (see docs/MCP-PROTOCOL.md).
// Don't list connector-runtime keys (PORT, INSPECTOR_PORT) — those are read
// by the SDK / connector, not the tool. Twilio-shipped tools list the
// standard Twilio keys (TWILIO_ACCOUNT_SID etc.) so the controller's
// auto-fill from the tunnel-security row picks them up.
export interface Tool {
  name: string;
  envKeys?: string[];
  register(server: McpServer): void;
}
