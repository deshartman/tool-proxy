import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ISO_DATETIME } from "../schemas.js";
import { commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: z.string(),
  flushedAt: ISO_DATETIME,
};

const OutputSchema = {
  flushed: z.boolean(),
};

// §5.6: clear sourceRefs → []; KEEP resolved for warm-start; update
// lastEngagedAt to flushedAt; do NOT delete the identity or cache row.
export const memorySemanticAgentFlush: Tool = {
  name: "memory_semantic_agent_flush",
  register(server) {
    server.registerTool(
      "memory_semantic_agent_flush",
      {
        title: "Flush semantic sourceRefs",
        description: "Empties sourceRefs while preserving resolved for warm-start on next bootstrap.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, flushedAt }) => {
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
          const data = { flushed: false };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        cache.sourceRefs = [];
        cache.lastEngagedAt = flushedAt;
        const failed = commitOrError();
        if (failed) return failed;
        const data = { flushed: true };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticAgentFlush;
