// Manifest-time guardrail for the controller-side hydration story
// (`{{ hydrate:<server>.<tool>.<field> }}`): every tool we author must
// declare an `outputSchema` so a procedure author gets autocomplete +
// type-check, and the controller's projectPath() has a contract to project
// against.
//
// Trust boundary mirrors CLAUDE.md "Architecturally load-bearing properties":
// we enforce on what we ship (Type 1 / Type 3) and observe-and-warn on what
// we don't (Type 2 externals — opaque upstream MCPs we don't author). Forcing
// Type 2 to declare a schema would either require retrofitting upstream code
// we don't own or block the connector booting against legitimate third-party
// MCPs; pragmatic answer is to surface the gap so the customer can decide.
//
// Off by default during the rollout — gated by STRICT_OUTPUT_SCHEMA so the
// check lands ahead of the per-tool schema work. Default flips to on after
// every tool we author has been migrated (see .claude/plans/OUTPUT-SCHEMA.md
// step S6).

import type { ToolManifest } from "../tunnel/frames.js";
import type { ConnectorConfig } from "../config.js";
import { isType1Spawn, isType3Bundled } from "../config.js";
import { envFlag } from "../env.js";
import { createLogger } from "../logger.js";

const log = createLogger("manifest-validate");

export function validateManifestSchemas(manifest: ToolManifest, config: ConnectorConfig): void {
  if (!envFlag("STRICT_OUTPUT_SCHEMA", false)) return;

  const specByName = new Map(config.mcp_servers.map((spec) => [spec.name, spec]));
  const authoredMissing: string[] = [];   // Type 1 / Type 3 — we own these
  const externalMissing: string[] = [];   // Type 2 — opaque upstream

  for (const server of manifest.servers) {
    const spec = specByName.get(server.name);
    const weAuthored = !!spec && (isType1Spawn(spec) || isType3Bundled(spec));
    for (const tool of server.tools) {
      if (tool.outputSchema !== undefined) continue;
      const id = `${server.name}.${tool.name}`;
      if (weAuthored) authoredMissing.push(id);
      else externalMissing.push(id);
    }
  }

  if (externalMissing.length > 0) {
    log.warn(
      { tools: externalMissing },
      `Type 2 (external) tools advertise no outputSchema (${externalMissing.length}): ` +
        `${externalMissing.join(", ")}. Controller-side hydration won't work for these. ` +
        `Upgrade upstream or set STRICT_OUTPUT_SCHEMA=0 to silence.`,
    );
  }

  if (authoredMissing.length > 0) {
    throw new Error(
      `Tools we author are missing outputSchema (${authoredMissing.length}): ` +
        `${authoredMissing.join(", ")}. See packages/connector/README.md ` +
        `"Author a Type 1 MCP" or .claude/plans/OUTPUT-SCHEMA.md.`,
    );
  }
}
