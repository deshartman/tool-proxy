import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { store } from "../state.js";

const InputSchema = {
  deletedCanonical: z.string().describe("Canonical procedure identifier (e.g. procedure:<id>) whose refs should be purged."),
};

const OutputSchema = {
  removedCount: z.number().int().min(0),
};

// §5.7 (OPTIONAL). Advertised as supportsPruneRefs: true in capabilities;
// removes any sourceRefs across all semantic cache rows whose target
// matches the deleted canonical.
export const memorySemanticPruneRefs: Tool = {
  name: "memory_semantic_prune_refs",
  register(server) {
    server.registerTool(
      "memory_semantic_prune_refs",
      {
        title: "Purge semantic refs pointing at a deleted procedure",
        description: "Sweep every identity's semantic cache and drop sourceRefs whose target matches deletedCanonical.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ deletedCanonical }) => {
        let removedCount = 0;
        let mutated = false;
        for (const externalId of Object.keys(store.state.semanticCache)) {
          const cache = store.state.semanticCache[externalId];
          if (!cache) continue;
          const before = cache.sourceRefs.length;
          cache.sourceRefs = cache.sourceRefs.filter((ref) => ref.target !== deletedCanonical);
          const delta = before - cache.sourceRefs.length;
          if (delta > 0) {
            removedCount += delta;
            mutated = true;
          }
        }
        if (mutated) store.commit();
        const data = { removedCount };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memorySemanticPruneRefs;
