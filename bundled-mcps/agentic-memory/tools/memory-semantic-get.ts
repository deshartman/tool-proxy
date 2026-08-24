import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ExternalIdSchema, HydrationReferenceSchema } from "../schemas.js";
import { store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: ExternalIdSchema,
};

// Semantic cache is best-effort. Missing rows return an empty shape rather
// than an error — §5.3 says a miss should return `{}` or `{sourceRefs: [],
// resolved: {}}`. We stabilise on the latter so callers always see the
// same keys.
const OutputSchema = {
  resolved: z.record(z.string(), z.unknown()),
  sourceRefs: z.array(HydrationReferenceSchema),
  hydratedAt: z.string().optional(),
  lastEngagedAt: z.string().optional(),
};

export const memorySemanticGet: Tool = {
  name: "memory_semantic_get",
  register(server) {
    server.registerTool(
      "memory_semantic_get",
      {
        title: "Read semantic cache",
        description: "Return the resolved bag + source refs for an identity. Miss returns empty shape, not an error.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId }) => {
        const identity = store.state.identities[externalId];
        if (!identity) return toolError("identity_not_found", `unknown externalId ${externalId}`);
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const cache = store.state.semanticCache[externalId];
        if (!cache) {
          const data = { resolved: {}, sourceRefs: [] };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        const data = {
          resolved: cache.resolved,
          sourceRefs: cache.sourceRefs,
          ...(cache.hydratedAt !== undefined ? { hydratedAt: cache.hydratedAt } : {}),
          ...(cache.lastEngagedAt !== undefined ? { lastEngagedAt: cache.lastEngagedAt } : {}),
        };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticGet;
