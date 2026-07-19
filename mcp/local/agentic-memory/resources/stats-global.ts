import type { Resource } from "@mcp-shim/connector/sdk";
import { store } from "../state.js";

// Static resource — global counts for the whole mock. Useful for demos:
// resources/read { uri: "stats://global" } returns a JSON summary of what
// the mock currently holds. No externalId — no per-identity data leaks.
export const statsGlobal: Resource = {
  name: "stats_global",
  register(server) {
    server.registerResource(
      "stats_global",
      "stats://global",
      {
        title: "Agentic-memory global stats",
        description: "Counts across identities / aliases / episodes / semantic-cache rows.",
        mimeType: "application/json",
      },
      async (uri) => {
        const identityCount = Object.keys(store.state.identities).length;
        const aliasCount = Object.keys(store.state.aliasIndex).length;
        const episodeCount = Object.values(store.state.episodes).reduce((sum, list) => sum + list.length, 0);
        const semanticCacheCount = Object.keys(store.state.semanticCache).length;
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ identityCount, aliasCount, episodeCount, semanticCacheCount }, null, 2),
            },
          ],
        };
      },
    );
  },
};

export default statsGlobal;
