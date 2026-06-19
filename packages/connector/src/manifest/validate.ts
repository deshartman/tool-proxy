// Manifest-time guardrail for the controller-side hydration story
// (`{{ hydrate:<server>.<tool>.<field> }}`): every Type 1 / Type 3 tool we
// author must declare an `outputSchema` so a procedure author gets
// autocomplete + type-check, and the controller's projectPath() has a
// contract to project against.
//
// Trust boundary mirrors CLAUDE.md "Architecturally load-bearing properties":
// we enforce on what we ship (Type 1 / Type 3); Type 2 (external upstream
// MCPs we don't author) passes through verbatim — the controller handles
// missing schemas gracefully on its end.
//
// Failure mode: log ERROR per offending tool and keep booting. A missing
// schema on a tool we author IS a developer-time bug (the per-tool tests
// at tests/mcp-tools/ assert outputSchema is defined), but if one slips
// through to a deployed image we'd rather have a loud log line than a dead
// connector — the rest of the manifest still works, and the broken tool
// just won't support hydration until we ship a fix.

import type { ToolManifest } from "../tunnel/frames.js";
import type { ConnectorConfig } from "../config.js";
import { isType1Spawn, isType3Bundled } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("manifest-validate");

export function validateManifestSchemas(manifest: ToolManifest, config: ConnectorConfig): void {
  const specByName = new Map(config.mcp_servers.map((spec) => [spec.name, spec]));

  for (const server of manifest.servers) {
    const spec = specByName.get(server.name);
    // Only check tools we author (Type 1 / Type 3). Type 2 entries advertise
    // whatever their upstream tools/list returns — pass through verbatim.
    const weAuthored = !!spec && (isType1Spawn(spec) || isType3Bundled(spec));
    if (!weAuthored) continue;

    for (const tool of server.tools) {
      if (tool.outputSchema !== undefined) continue;
      log.error(
        { server: server.name, tool: tool.name },
        `MCP implementation bug: Type 1/3 tool ${server.name}.${tool.name} ships without an outputSchema. ` +
          `Controller-side hydration ({{ hydrate:${server.name}.${tool.name}.<field> }}) will not work for this tool. ` +
          `Fix: declare outputSchema in the tool's registerTool config — see packages/connector/README.md "Author a Type 1 MCP".`,
      );
    }
  }
}
