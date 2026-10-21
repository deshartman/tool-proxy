import type { Resource } from "@gtmi/toolproxy-connector/sdk";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { store } from "../state.js";

// Read-only view of the most-recent episodes for an identity. Complements
// the memory_episodic_recall tool — resources are the right place for
// canonical, non-side-effecting reads that procedures can paste into their
// context (like the OUTPUT-SCHEMA hydration path).
const RECENT_LIMIT = 10;

export const memoryEpisodes: Resource = {
  name: "memory_episodes",
  register(server) {
    server.registerResource(
      "memory_episodes",
      new ResourceTemplate("memory://episodes/{externalId}", {
        list: async () => ({
          resources: Object.keys(store.state.episodes).map((id) => ({
            uri: `memory://episodes/${id}`,
            name: `memory_episodes:${id}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Recent episodes",
        description: "Most-recent 10 episodes for an identity. URI: memory://episodes/{externalId}",
        mimeType: "application/json",
      },
      async (uri, { externalId }) => {
        const key = Array.isArray(externalId) ? externalId[0] : externalId;
        const list = store.state.episodes[key ?? ""] ?? [];
        const recent = list.slice(-RECENT_LIMIT).reverse();
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ externalId: key, episodes: recent }, null, 2),
            },
          ],
        };
      },
    );
  },
};

export default memoryEpisodes;
