import type { ManifestDelta, ToolDescriptor, ToolManifest } from "../tunnel/frames.js";

// Structural diff per docs/MCP-TUNNEL.md:
//   "Tool name, allow-status, and schema *shape* count as structural changes
//    that warrant a push. Description text changes do not."
export function diffManifest(prev: ToolManifest, next: ToolManifest): ManifestDelta {
  const prevTools = flatten(prev);
  const nextTools = flatten(next);

  const added: ManifestDelta["added"] = [];
  const removed: ManifestDelta["removed"] = [];
  const changed: ManifestDelta["changed"] = [];

  for (const [key, t] of nextTools) {
    const before = prevTools.get(key);
    if (!before) {
      added.push({ server: t.server, tool: t.tool });
    } else if (isStructurallyDifferent(before.tool, t.tool)) {
      changed.push({ server: t.server, tool: t.tool });
    }
  }

  for (const [key, t] of prevTools) {
    if (!nextTools.has(key)) {
      removed.push({ server: t.server, tool: t.tool.name });
    }
  }

  return { added, removed, changed };
}

export function isEmptyDelta(d: ManifestDelta): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

function flatten(m: ToolManifest): Map<string, { server: string; tool: ToolDescriptor }> {
  const out = new Map<string, { server: string; tool: ToolDescriptor }>();
  for (const s of m.servers) {
    for (const t of s.tools) {
      out.set(`${s.name}.${t.name}`, { server: s.name, tool: t });
    }
  }
  return out;
}

function isStructurallyDifferent(a: ToolDescriptor, b: ToolDescriptor): boolean {
  if (a.allowed !== b.allowed) return true;
  if (!schemasEqual(a.inputSchema, b.inputSchema)) return true;
  if (!schemasEqual(a.outputSchema, b.outputSchema)) return true;
  return false;
}

// JSON-stringify equality is the cheapest "structural" comparison that's
// stable for JSON Schema bodies the MCP SDK passes through.
function schemasEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
