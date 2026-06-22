import { dirname, resolve } from "node:path";
import type { ConnectorConfig } from "../config.js";
import { authorOf } from "../config.js";
import type { McpServerConnection } from "../servers/index.js";
import { toDescriptor } from "../servers/index.js";
import type {
  PromptDescriptor,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ServerDescriptor,
  ToolManifest,
} from "../tunnel/frames.js";

// Aggregate tools/list (and, when capabilities advertise them, prompts/list +
// resources/list + resources/templates/list) across local MCP servers and
// produce the ToolManifest the connector pushes to the controller.
//
// Trust boundary is per-MCP-server, not per-capability — every discovered
// item is advertised verbatim.
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
    [...servers.values()].map((server) => buildServerDescriptor(server, specByName, yamlDir)),
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

async function buildServerDescriptor(
  server: McpServerConnection,
  specByName: Map<string, import("../config.js").McpServerSpec>,
  yamlDir: string,
): Promise<ServerDescriptor> {
  const tools = await server.listTools();
  const spec = specByName.get(server.name);
  // spec should always exist — servers come from the same config — but
  // default to "customer" if the lookup misses rather than erroring;
  // this is a tagging concern, not load-bearing for dispatch.
  const author = spec ? authorOf(spec, yamlDir) : "customer";

  const caps = server.capabilities;

  // Pull prompts/resources only when the upstream MCP advertised the
  // matching capability — calling list-X against an MCP that didn't would
  // produce -32601 and the empty list would be indistinguishable from
  // "advertised but empty." Keeping the gate explicit lets the inspector
  // render "off" vs "on but empty" correctly.
  const prompts: PromptDescriptor[] = caps?.prompts ? await safeList(server.listPrompts(), `prompts/list ${server.name}`) : [];
  const resources: ResourceDescriptor[] = caps?.resources ? await safeList(server.listResources(), `resources/list ${server.name}`) : [];
  const resourceTemplates: ResourceTemplateDescriptor[] = caps?.resources
    ? await safeList(server.listResourceTemplates(), `resources/templates/list ${server.name}`)
    : [];

  const descriptor: ServerDescriptor = {
    name: server.name,
    transport: server.transport,
    author,
    tools: tools.map((tool) => toDescriptor(tool, true)),
  };
  if (prompts.length > 0) descriptor.prompts = prompts;
  if (resources.length > 0) descriptor.resources = resources;
  if (resourceTemplates.length > 0) descriptor.resourceTemplates = resourceTemplates;
  if (caps && Object.keys(caps).length > 0) descriptor.capabilities = caps;

  return descriptor;
}

// Defensive helper: an upstream MCP that advertised a capability but rejects
// the corresponding list-method should surface the rejection in the manifest
// log, NOT crash buildManifest (which would crash the connector at boot).
async function safeList<T>(promise: Promise<T[]>, context: string): Promise<T[]> {
  try {
    return await promise;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[manifest-build] ${context} failed: ${(error as Error)?.message ?? String(error)}`);
    return [];
  }
}
