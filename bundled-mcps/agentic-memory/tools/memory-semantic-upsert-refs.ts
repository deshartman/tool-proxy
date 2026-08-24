import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { HydrationReferenceSchema, ISO_DATETIME } from "../schemas.js";
import type { HydrationReference } from "../state.js";
import { commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: z.string(),
  additionalRefs: z.array(HydrationReferenceSchema),
  now: ISO_DATETIME,
};

const OutputSchema = {
  resolved: z.record(z.string(), z.unknown()),
  sourceRefs: z.array(HydrationReferenceSchema),
  hydratedAt: z.string(),
  lastEngagedAt: z.string(),
};

function refKey(ref: HydrationReference): string {
  return `${ref.target ?? ref.label}::${ref.kind}`;
}

export const memorySemanticUpsertRefs: Tool = {
  name: "memory_semantic_upsert_refs",
  register(server) {
    server.registerTool(
      "memory_semantic_upsert_refs",
      {
        title: "Accumulate semantic source refs",
        description: "Additive-only merge: dedup by (target ?? label, kind); preserves existing refs; updates lastEngagedAt.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, additionalRefs, now }) => {
        const identity = store.state.identities[externalId];
        if (!identity) return toolError("identity_not_found", `unknown externalId ${externalId}`);
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const cache = store.state.semanticCache[externalId] ?? {
          resolved: {},
          sourceRefs: [],
          hydratedAt: now,
        };
        const seen = new Set(cache.sourceRefs.map(refKey));
        for (const ref of additionalRefs) {
          const k = refKey(ref);
          if (!seen.has(k)) {
            cache.sourceRefs.push(ref);
            seen.add(k);
          }
        }
        cache.hydratedAt = cache.hydratedAt ?? now;
        cache.lastEngagedAt = now;
        store.state.semanticCache[externalId] = cache;
        const failed = commitOrError();
        if (failed) return failed;
        const data = {
          resolved: cache.resolved,
          sourceRefs: cache.sourceRefs,
          hydratedAt: cache.hydratedAt,
          lastEngagedAt: cache.lastEngagedAt,
        };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticUpsertRefs;
