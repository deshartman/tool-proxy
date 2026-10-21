import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { AliasEntrySchema, ExternalIdSchema } from "../schemas.js";
import { store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: ExternalIdSchema,
};

const OutputSchema = {
  aliases: z.array(AliasEntrySchema),
};

export const identityListAliases: Tool = {
  name: "identity_list_aliases",
  register(server) {
    server.registerTool(
      "identity_list_aliases",
      {
        title: "Enumerate identity aliases",
        description: "Returns every alias currently bound to the identity. Empty array is a valid response.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId }) => {
        const identity = store.state.identities[externalId];
        if (!identity) {
          return toolError("identity_not_found", `unknown externalId ${externalId}`);
        }
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const data = { aliases: identity.aliases };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityListAliases;
