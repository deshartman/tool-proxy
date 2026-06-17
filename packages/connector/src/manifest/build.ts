import { dirname, resolve } from "node:path";
import type { ConnectorConfig } from "../config.js";
import { authorOf } from "../config.js";
import type { McpServerConnection } from "../servers/index.js";
import { toDescriptor } from "../servers/index.js";
import type { ServerDescriptor, ToolManifest } from "../tunnel/frames.js";

// Aggregate tools/list across local MCP servers and produce the ToolManifest
// the connector pushes to the controller. Trust boundary is per-MCP-server,
// not per-tool — every discovered tool is advertised as allowed=true.
//
// configPath is the absolute path to the loaded yaml — passed through so
// authorOf() can resolve relative `dir:` entries against the yaml's
// location and decide twilio-vs-customer per server.
export async function buildManifest(
  config: ConnectorConfig,
  servers: Map<string, McpServerConnection>,
  version: string,
  configPath: string,
): Promise<ToolManifest> {
  const yamlDir = dirname(resolve(configPath));
  const specByName = new Map(config.mcp_servers.map((server) => [server.name, server]));

  const serverEntries: ServerDescriptor[] = await Promise.all(
    [...servers.values()].map(async (server) => {
      const tools = await server.listTools();
      const spec = specByName.get(server.name);
      // spec should always exist — servers come from the same config — but
      // default to "customer" if the lookup misses rather than erroring;
      // this is a tagging concern, not load-bearing for dispatch.
      const author = spec ? authorOf(spec, yamlDir) : "customer";
      return {
        name: server.name,
        transport: server.transport,
        author,
        tools: tools.map((tool) => toDescriptor(tool, true)),
      };
    })
  );

  // Stable ordering: keep server order from YAML so diffs are deterministic.
  const orderByName = new Map(config.mcp_servers.map((server, index) => [server.name, index]));
  serverEntries.sort((a, b) => (orderByName.get(a.name) ?? 0) - (orderByName.get(b.name) ?? 0));

  return {
    // Empty on the wire. The controller resolves identity from the register
    // frame's `name` / `registrationToken` and stamps the manifest with the
    // canonical connectorId before storing it.
    connectorId: "",
    environment: config.tunnel.environment,
    version,
    servers: serverEntries,
  };
}
