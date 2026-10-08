import type { ConnectorConfig } from "../config.js";
import { authorOf } from "../config.js";
import { isDropinSpec } from "../dropin.js";
import { createLogger } from "../logger.js";
import type { McpServerConnection } from "../servers/index.js";
import { toDescriptor } from "../servers/index.js";
import type {
  PromptDescriptor,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ServerDescriptor,
  ToolManifest,
} from "../tunnel/frames.js";

const log = createLogger("manifest-build");

// Aggregate tools/list (and, when capabilities advertise them, prompts/list +
// resources/list + resources/templates/list) across local MCP servers and
// produce the ToolManifest the connector pushes to the controller.
//
// Trust boundary is per-MCP-server, not per-capability — every discovered
// item is advertised verbatim.
//
// gatedSpecsByName names the entries the approval gate applies to. Since
// Phase 2c (D3) that is every MCP the connector runs itself — bundled,
// customer drop-in and yaml — and never a controller-pushed (Type 2) one.
// Only `.has(name)` is consulted. Optional + best-effort: when omitted, no
// entries are gated (preserves older boot paths and tests). Empty map →
// same effect.
export async function buildManifest(
  config: ConnectorConfig,
  servers: Map<string, McpServerConnection>,
  version: string,
  // INSPECTOR-CREDS-VISIBILITY (W-S7): optional async hook for resolving
  // an MCP's aggregate envKeys union. Wired by lifecycle.ts to the
  // supervisor's `fetchEnvKeys`. Optional so tests / older boot paths
  // can omit it; absent → ServerDescriptor.envKeys is undefined and the
  // inspector falls back to "no badge".
  envKeysFor?: (name: string) => Promise<string[]>,
  // Approval gate. Predicate consulted ONLY for entries in gatedSpecsByName;
  // when it returns false the entire ServerDescriptor is omitted from the
  // manifest. Controller-config (Type 2) entries are never in that map, so
  // bypass it. Optional so tests + older boot paths can omit it (absent ≡
  // all-approved).
  isApproved?: (name: string) => boolean,
  // Gated-entry lookup, keyed by name. Boot wiring builds it once from the
  // bundled scan, the drop-in scan and connector.yaml.
  gatedSpecsByName?: Map<string, unknown>,
  // Additional specs discovered outside the yaml (bundled-mcps/ + drop-ins).
  // Author classification (authorOf) sees these — a bundled entry needs its
  // __author marker preserved so ServerDescriptor.author is "twilio".
  additionalSpecs?: Iterable<import("../config.js").McpServerSpec>,
): Promise<ToolManifest> {
  const specByName = new Map(config.mcp_servers.map((server) => [server.name, server]));
  if (additionalSpecs) {
    for (const spec of additionalSpecs) specByName.set(spec.name, spec);
  }

  const allEntries: Array<ServerDescriptor | undefined> = await Promise.all(
    [...servers.values()].map(async (server) => {
      // Gate predicate: "name appears in the gated map" — set up by boot
      // wiring. We deliberately don't peek at McpServerSpec internals here,
      // so gating follows exactly one classification.
      const isGated = gatedSpecsByName?.has(server.name) ?? false;
      if (isGated && isApproved && !isApproved(server.name)) {
        return undefined;
      }
      return buildServerDescriptor(server, specByName, envKeysFor);
    }),
  );

  const serverEntries = allEntries.filter((entry): entry is ServerDescriptor => entry !== undefined);

  // Stable ordering: keep server order from YAML so diffs are deterministic.
  const orderByName = new Map(config.mcp_servers.map((server, index) => [server.name, index]));
  serverEntries.sort((a, b) => (orderByName.get(a.name) ?? 0) - (orderByName.get(b.name) ?? 0));

  return {
    // Empty on the wire. The controller resolves identity from the register
    // frame's `name` / `registrationToken` and stamps the manifest with the
    // canonical connectorId before storing it.
    connectorId: "",
    // config.tunnel is legacy (env-mode holdover) and may be undefined. Fall
    // back to the "dev" default the schema previously baked in via .default().
    environment: config.tunnel?.environment ?? "dev",
    version,
    servers: serverEntries,
  };
}

// Helper: build the drop-in name set the manifest gate consults. Boot
// wiring calls this once per buildManifest pass with `discoverDropins()`'s
// output. Exposed so the inspector and tests can re-use the same
// classification rule.
export function dropinSpecsToMap(specs: Iterable<unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const spec of specs) {
    if (isDropinSpec(spec as never) && (spec as { name: string }).name) {
      map.set((spec as { name: string }).name, spec);
    }
  }
  return map;
}

async function buildServerDescriptor(
  server: McpServerConnection,
  specByName: Map<string, import("../config.js").McpServerSpec>,
  envKeysFor?: (name: string) => Promise<string[]>,
): Promise<ServerDescriptor> {
  const tools = await safeList(server.listTools(), `tools/list ${server.name}`);
  const spec = specByName.get(server.name);
  // spec should always exist — servers come from the same config — but
  // default to "customer" if the lookup misses rather than erroring;
  // this is a tagging concern, not load-bearing for dispatch.
  const author = spec ? authorOf(spec) : "customer";

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
  // §9.2 — negotiated protocol era, captured on the connection at connect time.
  if (server.protocolVersion) descriptor.protocolVersion = server.protocolVersion;
  // INSPECTOR-CREDS-VISIBILITY (W-S7): aggregate envKeys union for the
  // MCP, surfaced so the inspector can render an "Awaiting config" badge
  // when the MCP declared keys but no creds are set. Best-effort: a
  // fetch failure (Type 2 stdio, child not yet ready) yields [] and we
  // simply omit the field — the badge logic treats that as "no
  // expectations", same as a tool with empty envKeys today.
  if (envKeysFor) {
    try {
      const keys = await envKeysFor(server.name);
      if (keys.length > 0) descriptor.envKeys = keys;
    } catch {
      // best-effort; manifest still ships without the field.
    }
  }

  return descriptor;
}

// Defensive helper: an upstream MCP that advertised a capability but rejects
// the corresponding list-method should surface the rejection in the manifest
// log, NOT crash buildManifest (which would crash the connector at boot).
async function safeList<T>(promise: Promise<T[]>, context: string): Promise<T[]> {
  try {
    return await promise;
  } catch (error) {
    log.error({ context, err: error }, "list failed");
    return [];
  }
}
