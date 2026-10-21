import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { AliasEntrySchema, ChannelSchema } from "../schemas.js";
import { NormalizationError, normalizeChannelValue } from "../normalize.js";
import { aliasKey, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  channel: ChannelSchema,
  value: z.string(),
  displayName: z.string().optional(),
};

const OutputSchema = {
  externalId: z.string().nullable(),
  aliases: z.array(AliasEntrySchema),
};

export const identityLookup: Tool = {
  name: "identity_lookup",
  register(server) {
    server.registerTool(
      "identity_lookup",
      {
        title: "Look up identity without creating",
        description: "Find an identity by channel identifier. Returns null when no match — DOES NOT create.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ channel, value }) => {
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
        const existingId = store.state.aliasIndex[key];
        if (!existingId) {
          const data = { externalId: null, aliases: [] };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        const identity = store.state.identities[existingId];
        if (identity?.mergedInto) {
          const winner = store.state.identities[identity.mergedInto];
          const data = {
            externalId: winner?.externalId ?? identity.mergedInto,
            aliases: winner?.aliases ?? [],
          };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        const data = {
          externalId: existingId,
          aliases: identity?.aliases ?? [],
        };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityLookup;
