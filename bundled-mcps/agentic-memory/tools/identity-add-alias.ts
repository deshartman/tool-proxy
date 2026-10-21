import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
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
  wasAlreadyPresent: z.boolean(),
};

export const identityAddAlias: Tool = {
  name: "identity_add_alias",
  register(server) {
    server.registerTool(
      "identity_add_alias",
      {
        title: "Attach channel identifier to identity",
        description: "Idempotent — re-adding an existing alias is a no-op with wasAlreadyPresent=true.",
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
        const existingOwner = store.state.aliasIndex[key];
        if (existingOwner === externalId) {
          const data = { success: true, wasAlreadyPresent: true };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        if (existingOwner && existingOwner !== externalId) {
          return toolError(
            "invalid_identifier",
            `alias ${key} already bound to a different identity (${existingOwner})`,
          );
        }
        identity.aliases.push({ channel, value: normalised, addedAt: new Date().toISOString() });
        store.state.aliasIndex[key] = externalId;
        const failed = commitOrError();
        if (failed) return failed;
        const data = { success: true, wasAlreadyPresent: false };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityAddAlias;
