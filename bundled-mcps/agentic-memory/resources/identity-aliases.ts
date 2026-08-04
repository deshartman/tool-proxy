import type { Resource } from "@mcp-shim/connector/sdk";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { store } from "../state.js";

// URI template — one aliases resource per identity. Callers do
// `resources/read { uri: "identity://aliases/<externalId>" }` and get the
// current alias list back as JSON. Read-only view; mutations go through
// the identity_add_alias / identity_remove_alias tools.
export const identityAliases: Resource = {
  name: "identity_aliases",
  register(server) {
    server.registerResource(
      "identity_aliases",
      new ResourceTemplate("identity://aliases/{externalId}", {
        list: async () => ({
          resources: Object.keys(store.state.identities)
            .filter((id) => !store.state.identities[id]?.mergedInto)
            .map((id) => ({
              uri: `identity://aliases/${id}`,
              name: `identity_aliases:${id}`,
              mimeType: "application/json",
            })),
        }),
      }),
      {
        title: "Identity aliases",
        description: "Alias list for a given externalId. URI: identity://aliases/{externalId}",
        mimeType: "application/json",
      },
      async (uri, { externalId }) => {
        const key = Array.isArray(externalId) ? externalId[0] : externalId;
        const row = store.state.identities[key ?? ""];
        const aliases = row && !row.mergedInto ? row.aliases : [];
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ externalId: key, aliases }, null, 2),
            },
          ],
        };
      },
    );
  },
};

export default identityAliases;
