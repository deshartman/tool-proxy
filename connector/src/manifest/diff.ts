import type {
  ManifestDelta,
  PromptDescriptor,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ToolDescriptor,
  ToolManifest,
} from "../tunnel/frames.js";

// Structural diff per docs/MCP-TUNNEL.md:
//   "Tool name, allow-status, and schema *shape* count as structural changes
//    that warrant a push. Description text changes do not."
//
// v1.2 — MCP-CLIENT-USE. Prompts/resources/resourceTemplates use the same
// add/remove/change shape, with structural-change semantics adapted to each:
//   * Prompt — argument list shape (names + required flags) counts; description doesn't
//   * Resource — uri + mimeType count; description doesn't
//   * ResourceTemplate — uriTemplate + mimeType count; description doesn't
//
// We deliberately surface these as separate delta arrays rather than
// reinterpreting `added`/`removed`/`changed` to a generic shape — older
// controllers only consume the tools fields and skip the new ones, which
// keeps backwards-compat trivial.
export function diffManifest(prev: ToolManifest, next: ToolManifest): ManifestDelta {
  const prevTools = flattenTools(prev);
  const nextTools = flattenTools(next);

  const added: ManifestDelta["added"] = [];
  const removed: ManifestDelta["removed"] = [];
  const changed: ManifestDelta["changed"] = [];

  for (const [key, entry] of nextTools) {
    const before = prevTools.get(key);
    if (!before) added.push({ server: entry.server, tool: entry.tool });
    else if (isToolStructurallyDifferent(before.tool, entry.tool)) changed.push({ server: entry.server, tool: entry.tool });
  }
  for (const [key, entry] of prevTools) {
    if (!nextTools.has(key)) removed.push({ server: entry.server, tool: entry.tool.name });
  }

  const promptDelta = diffPrompts(prev, next);
  const resourceDelta = diffResources(prev, next);
  const templateDelta = diffResourceTemplates(prev, next);

  return {
    added,
    removed,
    changed,
    ...(promptDelta.added.length > 0 ? { addedPrompts: promptDelta.added } : {}),
    ...(promptDelta.removed.length > 0 ? { removedPrompts: promptDelta.removed } : {}),
    ...(promptDelta.changed.length > 0 ? { changedPrompts: promptDelta.changed } : {}),
    ...(resourceDelta.added.length > 0 ? { addedResources: resourceDelta.added } : {}),
    ...(resourceDelta.removed.length > 0 ? { removedResources: resourceDelta.removed } : {}),
    ...(resourceDelta.changed.length > 0 ? { changedResources: resourceDelta.changed } : {}),
    ...(templateDelta.added.length > 0 ? { addedResourceTemplates: templateDelta.added } : {}),
    ...(templateDelta.removed.length > 0 ? { removedResourceTemplates: templateDelta.removed } : {}),
    ...(templateDelta.changed.length > 0 ? { changedResourceTemplates: templateDelta.changed } : {}),
  };
}

export function isEmptyDelta(delta: ManifestDelta): boolean {
  return delta.added.length === 0
    && delta.removed.length === 0
    && delta.changed.length === 0
    && (delta.addedPrompts ?? []).length === 0
    && (delta.removedPrompts ?? []).length === 0
    && (delta.changedPrompts ?? []).length === 0
    && (delta.addedResources ?? []).length === 0
    && (delta.removedResources ?? []).length === 0
    && (delta.changedResources ?? []).length === 0
    && (delta.addedResourceTemplates ?? []).length === 0
    && (delta.removedResourceTemplates ?? []).length === 0
    && (delta.changedResourceTemplates ?? []).length === 0;
}

function flattenTools(manifest: ToolManifest): Map<string, { server: string; tool: ToolDescriptor }> {
  const out = new Map<string, { server: string; tool: ToolDescriptor }>();
  for (const server of manifest.servers) {
    for (const tool of server.tools) {
      out.set(`${server.name}.${tool.name}`, { server: server.name, tool });
    }
  }
  return out;
}

function isToolStructurallyDifferent(a: ToolDescriptor, b: ToolDescriptor): boolean {
  if (a.allowed !== b.allowed) return true;
  if (!schemasEqual(a.inputSchema, b.inputSchema)) return true;
  if (!schemasEqual(a.outputSchema, b.outputSchema)) return true;
  return false;
}

interface PromptDeltaParts {
  added: NonNullable<ManifestDelta["addedPrompts"]>;
  removed: NonNullable<ManifestDelta["removedPrompts"]>;
  changed: NonNullable<ManifestDelta["changedPrompts"]>;
}

function diffPrompts(prev: ToolManifest, next: ToolManifest): PromptDeltaParts {
  const flatten = (m: ToolManifest): Map<string, { server: string; prompt: PromptDescriptor }> => {
    const out = new Map<string, { server: string; prompt: PromptDescriptor }>();
    for (const server of m.servers) {
      for (const prompt of server.prompts ?? []) {
        out.set(`${server.name}.${prompt.name}`, { server: server.name, prompt });
      }
    }
    return out;
  };
  const before = flatten(prev);
  const after = flatten(next);
  const added: PromptDeltaParts["added"] = [];
  const removed: PromptDeltaParts["removed"] = [];
  const changed: PromptDeltaParts["changed"] = [];
  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) added.push({ server: entry.server, prompt: entry.prompt });
    else if (!schemasEqual(prior.prompt.arguments, entry.prompt.arguments)) {
      changed.push({ server: entry.server, prompt: entry.prompt });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ server: entry.server, prompt: entry.prompt.name });
  }
  return { added, removed, changed };
}

interface ResourceDeltaParts {
  added: NonNullable<ManifestDelta["addedResources"]>;
  removed: NonNullable<ManifestDelta["removedResources"]>;
  changed: NonNullable<ManifestDelta["changedResources"]>;
}

function diffResources(prev: ToolManifest, next: ToolManifest): ResourceDeltaParts {
  const flatten = (m: ToolManifest): Map<string, { server: string; resource: ResourceDescriptor }> => {
    const out = new Map<string, { server: string; resource: ResourceDescriptor }>();
    for (const server of m.servers) {
      for (const resource of server.resources ?? []) {
        out.set(`${server.name}.${resource.uri}`, { server: server.name, resource });
      }
    }
    return out;
  };
  const before = flatten(prev);
  const after = flatten(next);
  const added: ResourceDeltaParts["added"] = [];
  const removed: ResourceDeltaParts["removed"] = [];
  const changed: ResourceDeltaParts["changed"] = [];
  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) added.push({ server: entry.server, resource: entry.resource });
    else if (prior.resource.mimeType !== entry.resource.mimeType || prior.resource.name !== entry.resource.name) {
      changed.push({ server: entry.server, resource: entry.resource });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ server: entry.server, resource: entry.resource.uri });
  }
  return { added, removed, changed };
}

interface TemplateDeltaParts {
  added: NonNullable<ManifestDelta["addedResourceTemplates"]>;
  removed: NonNullable<ManifestDelta["removedResourceTemplates"]>;
  changed: NonNullable<ManifestDelta["changedResourceTemplates"]>;
}

function diffResourceTemplates(prev: ToolManifest, next: ToolManifest): TemplateDeltaParts {
  const flatten = (m: ToolManifest): Map<string, { server: string; resourceTemplate: ResourceTemplateDescriptor }> => {
    const out = new Map<string, { server: string; resourceTemplate: ResourceTemplateDescriptor }>();
    for (const server of m.servers) {
      for (const tmpl of server.resourceTemplates ?? []) {
        out.set(`${server.name}.${tmpl.uriTemplate}`, { server: server.name, resourceTemplate: tmpl });
      }
    }
    return out;
  };
  const before = flatten(prev);
  const after = flatten(next);
  const added: TemplateDeltaParts["added"] = [];
  const removed: TemplateDeltaParts["removed"] = [];
  const changed: TemplateDeltaParts["changed"] = [];
  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) added.push({ server: entry.server, resourceTemplate: entry.resourceTemplate });
    else if (prior.resourceTemplate.mimeType !== entry.resourceTemplate.mimeType || prior.resourceTemplate.name !== entry.resourceTemplate.name) {
      changed.push({ server: entry.server, resourceTemplate: entry.resourceTemplate });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ server: entry.server, resourceTemplate: entry.resourceTemplate.uriTemplate });
  }
  return { added, removed, changed };
}

// JSON-stringify equality is the cheapest "structural" comparison that's
// stable for JSON Schema bodies the MCP SDK passes through.
function schemasEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
