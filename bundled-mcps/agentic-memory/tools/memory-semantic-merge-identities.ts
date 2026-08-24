import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ISO_DATETIME } from "../schemas.js";
import type { HydrationReference } from "../state.js";
import { commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  winner: z.string(),
  loser: z.string(),
  mergedAt: ISO_DATETIME,
};

const OutputSchema = {
  success: z.boolean(),
};

function refKey(ref: HydrationReference): string {
  return `${ref.target ?? ref.label}::${ref.kind}`;
}

// §5.8 (OPTIONAL). Sibling to identity_merge but for the semantic cache
// only. Union refs (winner-preserving dedup), merge resolved (winner keys
// win on conflict), update lastEngagedAt, delete loser cache row. This
// tool DOES NOT touch the identity table; the orchestrator calls
// identity_merge first.
export const memorySemanticMergeIdentities: Tool = {
  name: "memory_semantic_merge_identities",
  register(server) {
    server.registerTool(
      "memory_semantic_merge_identities",
      {
        title: "Merge semantic cache of loser into winner",
        description: "Union refs, merge resolved (winner keys win), delete loser cache row. Sibling to identity_merge.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ winner, loser, mergedAt }) => {
        if (winner === loser) {
          return toolError("invalid_identifier", "winner and loser must differ");
        }
        const loserCache = store.state.semanticCache[loser];
        if (!loserCache) {
          const data = { success: true };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        const winnerCache = store.state.semanticCache[winner] ?? {
          resolved: {},
          sourceRefs: [],
          hydratedAt: mergedAt,
        };
        const seen = new Set(winnerCache.sourceRefs.map(refKey));
        for (const ref of loserCache.sourceRefs) {
          if (!seen.has(refKey(ref))) {
            winnerCache.sourceRefs.push(ref);
            seen.add(refKey(ref));
          }
        }
        winnerCache.resolved = { ...loserCache.resolved, ...winnerCache.resolved };
        winnerCache.lastEngagedAt = mergedAt;
        store.state.semanticCache[winner] = winnerCache;
        delete store.state.semanticCache[loser];
        const failed = commitOrError();
        if (failed) return failed;
        const data = { success: true };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticMergeIdentities;
