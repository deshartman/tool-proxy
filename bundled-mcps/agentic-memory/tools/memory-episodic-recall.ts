import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { EpisodeSchema } from "../schemas.js";
import { store } from "../state.js";
import type { Episode } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: z.string(),
  query: z.string().describe("Free-text query. Empty = most-recent N."),
  opts: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    procedureId: z.string().optional(),
    includeUnscoped: z.boolean().optional(),
    sinceMs: z.number().int().nonnegative().optional(),
  }),
};

const OutputSchema = {
  episodes: z.array(EpisodeSchema),
};

// Recency + keyword-blend scoring. Cheap approximation of a real vector
// search — declared as supportsVectorSearch: false in capabilities so the
// controller knows to expect fuzzy relevance.
function scoreEpisode(query: string, episode: Episode, nowMs: number): number {
  const occurredMs = Date.parse(episode.occurredAt);
  const daysAgo = Math.max(0, (nowMs - occurredMs) / 86_400_000);
  const recency = 1 / (1 + daysAgo);
  const q = query.trim();
  if (q.length === 0) return recency;
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return recency;
  const haystack = episode.summary.toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t)).length;
  const keyword = hits / terms.length;
  return Math.min(1, 0.4 * recency + 0.6 * keyword);
}

export const memoryEpisodicRecall: Tool = {
  name: "memory_episodic_recall",
  register(server) {
    server.registerTool(
      "memory_episodic_recall",
      {
        title: "Recall episodes for an identity",
        description: "Fuzzy recall — empty query returns most-recent limit episodes (default 5).",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, query, opts }) => {
        const identity = store.state.identities[externalId];
        if (!identity) return toolError("identity_not_found", `unknown externalId ${externalId}`);
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const limit = opts.limit ?? 5;
        const nowMs = Date.now();
        const cutoffMs = opts.sinceMs !== undefined ? nowMs - opts.sinceMs : Number.NEGATIVE_INFINITY;
        const all = store.state.episodes[externalId] ?? [];
        const filtered = all.filter((e) => {
          if (Date.parse(e.occurredAt) < cutoffMs) return false;
          if (opts.procedureId !== undefined) {
            if (e.procedureId === opts.procedureId) return true;
            if (opts.includeUnscoped && e.procedureId === undefined) return true;
            return false;
          }
          return true;
        });
        const scored = filtered
          .map((e) => ({ ...e, score: scoreEpisode(query, e, nowMs) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        const data = { episodes: scored };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memoryEpisodicRecall;
