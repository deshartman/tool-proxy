// Boot-time `mcp-discovered` fan-out (v1.3 — customer drop-in approval).
//
// Extracted from lifecycle.ts so the loop is testable without booting the
// full process. The controller uses each emitted frame for TWO purposes:
//
//   (a) Look up the MCP in its approval table keyed on (connectorId, mcp)
//       and replay `mcp-enable` for previously-approved MCPs.
//   (b) Classify the MCP as Live (approved + seen this session) vs Orphaned
//       (approved + not seen this session). The presence of the frame is
//       what flips Orphaned → Live for previously-approved drop-ins.
//
// The fan-out announces every drop-in UNCONDITIONALLY. Gating on
// `approval.isApproved(name)` mid-loop is unsafe: the controller's
// mcp-enable replay arrives synchronously between the loop's awaits and
// mutates the approved set, causing later iterations to skip — leaving
// those drop-ins parked in the controller's Orphaned lane until the next
// connector restart. `emitDiscovered` is idempotent on the controller side
// (per docs/MCP-PROTOCOL.md §"v1.3"), so the redundant frames are free.
//
// Manual repro that originally surfaced the bug: 2026-06-26 — two drop-ins
// (crm, sample), crm announced and sample skipped (`announced: 1,
// totalDropins: 2` in the boot log). See the regression test at
// tests/boot/announce-dropins.test.ts.

import type { McpSupervisor } from "../mcp-supervisor.js";
import type { McpServerConnection } from "../servers/index.js";
import type { ApprovalCoordinator } from "../tunnel/approval-coordinator.js";
import type { Logger } from "../logger.js";

export interface AnnounceDropinsDeps {
  dropinNames: readonly string[];
  approval: ApprovalCoordinator;
  supervisor: Pick<McpSupervisor, "fetchEnvKeys">;
  servers: Map<string, McpServerConnection>;
  log: Logger;
}

export interface AnnounceDropinsResult {
  announced: number;
  totalDropins: number;
}

export async function announceDiscoveredDropins(
  deps: AnnounceDropinsDeps,
): Promise<AnnounceDropinsResult> {
  const { dropinNames, approval, supervisor, servers, log } = deps;
  if (dropinNames.length === 0) {
    return { announced: 0, totalDropins: 0 };
  }
  let announced = 0;
  for (const name of dropinNames) {
    try {
      const envKeys = await supervisor.fetchEnvKeys(name);
      const conn = servers.get(name);
      const tools = conn ? await conn.listTools() : [];
      approval.emitDiscovered({
        mcp: name,
        envKeys,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      announced += 1;
    } catch (err) {
      log.warn({ name, err: err as Error }, `mcp-discovered emission failed for drop-in`);
    }
  }
  return { announced, totalDropins: dropinNames.length };
}
