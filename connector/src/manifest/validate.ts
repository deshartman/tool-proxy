// Manifest-time advisory for the controller-side hydration story
// (`{{ hydrate:<server>.<tool>.<field> }}`). Tools that declare an
// `outputSchema` get controller-side autocomplete + field projection.
// Tools that don't are still callable — the controller surfaces them by
// name only (no field-projection) and that may be all an MCP author ever
// wants. This module just informs the operator what's available where.
//
// Scope: we only check MCPs we ship in this image (customer-authored
// Type 1 sources under `mcp/local/`, Twilio bundles under `mcp/bundled/`).
// External MCPs reached via `endpoint:` / `command:` advertise whatever
// their upstream tools/list returns; the controller handles them as-is.

import type { ToolManifest } from "../tunnel/frames.js";
import type { ConnectorConfig } from "../config.js";
import { isType1Spawn, isType3Bundled } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("manifest-validate");

export function validateManifestSchemas(manifest: ToolManifest, config: ConnectorConfig): void {
  const specByName = new Map(config.mcp_servers.map((spec) => [spec.name, spec]));

  for (const server of manifest.servers) {
    const spec = specByName.get(server.name);
    // Only check MCPs whose source we ship (Type 1 / Type 3). External
    // upstream MCPs advertise whatever their tools/list returns — pass
    // through verbatim.
    const weShipIt = !!spec && (isType1Spawn(spec) || isType3Bundled(spec));
    if (!weShipIt) continue;

    const missing = server.tools.filter((tool) => tool.outputSchema === undefined).map((tool) => tool.name);
    if (missing.length === 0) continue;

    log.warn(
      { server: server.name, tools: missing },
      `${server.name}: ${missing.length} tool${missing.length === 1 ? "" : "s"} (${missing.join(", ")}) ` +
        `do${missing.length === 1 ? "es" : ""} not declare outputSchema — the controller will surface ${missing.length === 1 ? "this tool" : "these tools"} by name only ` +
        `(no field-projection). Add outputSchema to enable {{ hydrate:${server.name}.<tool>.<field> }} — see connector/README.md "Author a Type 1 MCP".`,
    );
  }
}
