import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ChannelSchema, ExternalIdSchema } from "../schemas.js";
import { NormalizationError, normalizeChannelValue } from "../normalize.js";
import { aliasKey, commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  externalId: ExternalIdSchema,
  channel: ChannelSchema,
  value: z.string(),
};

const OutputSchema = {
  success: z.boolean(),
  wasPresent: z.boolean(),
};

export const identityRemoveAlias: Tool = {
  name: "identity_remove_alias",
  register(server) {
    server.registerTool(
      "identity_remove_alias",
      {
        title: "Detach channel identifier from identity",
        description: "Idempotent — removing an absent alias is a no-op with wasPresent=false.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, channel, value }) => {
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
        let normalised: string;
        try {
          normalised = normalizeChannelValue(channel, value);
        } catch (err) {
          if (err instanceof NormalizationError) {
            return toolError("invalid_identifier", err.message);
          }
          throw err;
        }
        const key = aliasKey(channel, normalised);
        const before = identity.aliases.length;
        identity.aliases = identity.aliases.filter(
          (a) => !(a.channel === channel && a.value === normalised),
        );
        const wasPresent = identity.aliases.length !== before;
        if (wasPresent && store.state.aliasIndex[key] === externalId) {
          delete store.state.aliasIndex[key];
        }
        if (wasPresent) {
          const failed = commitOrError();
          if (failed) return failed;
        }
        const data = { success: true, wasPresent };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityRemoveAlias;
