import type { ConnectorConfig } from "../config.js";
import type { McpServerConnection } from "../servers/index.js";
import { toDescriptor } from "../servers/index.js";
import { AllowList } from "../policy/allow-list.js";
import type { ServerDescriptor, ToolManifest } from "../tunnel/frames.js";

// Aggregate tools/list across local MCP servers, apply the allow-list, and
// produce the ToolManifest the connector pushes to the controller.
export async function buildManifest(
  config: ConnectorConfig,
  servers: Map<string, McpServerConnection>,
  version: string
): Promise<ToolManifest> {
  const allow = new AllowList(config);

  const serverEntries: ServerDescriptor[] = await Promise.all(
    [...servers.values()].map(async (s) => {
      const tools = await s.listTools();
      return {
        name: s.name,
        transport: s.transport,
        tools: tools.map((t) => toDescriptor(t, allow.isAllowed(s.name, t.name))),
      };
    })
  );

  // Stable ordering: keep server order from YAML so diffs are deterministic.
  const orderByName = new Map(config.mcp_servers.map((s, i) => [s.name, i]));
  serverEntries.sort((a, b) => (orderByName.get(a.name) ?? 0) - (orderByName.get(b.name) ?? 0));

  return {
    connectorId: config.tunnel.connector_id,
    environment: config.tunnel.environment,
    version,
    servers: serverEntries,
  };
}
