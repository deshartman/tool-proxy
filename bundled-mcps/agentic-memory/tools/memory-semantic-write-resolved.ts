import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { ExternalIdSchema, ISO_DATETIME } from "../schemas.js";
import { commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: ExternalIdSchema,
  resolved: z.record(z.string(), z.unknown()),
  hydratedAt: ISO_DATETIME,
};

const OutputSchema = {
  success: z.boolean(),
};

// §5.5: overwrite `resolved` entirely; update `hydratedAt`; preserve
// `sourceRefs` + `lastEngagedAt`.
export const memorySemanticWriteResolved: Tool = {
  name: "memory_semantic_write_resolved",
  register(server) {
    server.registerTool(
      "memory_semantic_write_resolved",
      {
        title: "Persist resolved semantic bag",
        description: "Overwrites the resolved bag; refreshes hydratedAt; preserves sourceRefs and lastEngagedAt.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, resolved, hydratedAt }) => {
        const identity = store.state.identities[externalId];
        if (!identity) return toolError("identity_not_found", `unknown externalId ${externalId}`);
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const existing = store.state.semanticCache[externalId];
        store.state.semanticCache[externalId] = {
          resolved,
          sourceRefs: existing?.sourceRefs ?? [],
          hydratedAt,
          ...(existing?.lastEngagedAt !== undefined ? { lastEngagedAt: existing.lastEngagedAt } : {}),
        };
        const failed = commitOrError();
        if (failed) return failed;
        const data = { success: true };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticWriteResolved;
