import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { AliasEntrySchema, ChannelSchema } from "../schemas.js";
import { NormalizationError, normalizeChannelValue } from "../normalize.js";
import { externalIdFor } from "../id.js";
import { aliasKey, commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  channel: ChannelSchema,
  value: z.string().describe("Raw identifier — server normalises per §4.1."),
  displayName: z.string().optional().describe("Optional hint; ignored by this mock."),
};

const OutputSchema = {
  externalId: z.string(),
  isNew: z.boolean(),
  aliases: z.array(AliasEntrySchema),
};

export const identityResolve: Tool = {
  name: "identity_resolve",
  register(server) {
    server.registerTool(
      "identity_resolve",
      {
        title: "Resolve identity from channel identifier",
        description: "Find or create an identity for a (channel, value) pair. Deterministic externalId per (channel, normalisedValue).",
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
        const now = new Date().toISOString();

        if (existingId) {
          const identity = store.state.identities[existingId];
          if (identity?.mergedInto) {
            const winner = store.state.identities[identity.mergedInto];
            const data = {
              externalId: winner?.externalId ?? identity.mergedInto,
              isNew: false,
              aliases: winner?.aliases ?? [],
            };
            return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
          }
          const data = {
            externalId: existingId,
            isNew: false,
            aliases: identity?.aliases ?? [],
          };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
        }

        const externalId = externalIdFor(channel, normalised);
        const alias = { channel, value: normalised, addedAt: now };
        store.state.identities[externalId] = {
          externalId,
          aliases: [alias],
          createdAt: now,
        };
        store.state.aliasIndex[key] = externalId;
        const failed = commitOrError();
        if (failed) return failed;

        const data = { externalId, isNew: true, aliases: [alias] };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityResolve;
