import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ChannelSchema, ExternalIdSchema, ISO_DATETIME, MAX_EPISODES_PER_IDENTITY, SummarySchema } from "../schemas.js";
import { createLogger } from "@mcp-shim/connector/sdk";
import { episodeId } from "../id.js";
import { commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const log = createLogger("agentic-memory");

const InputSchema = {
  externalId: ExternalIdSchema,
  summary: SummarySchema,
  metadata: z.object({
    channelKind: ChannelSchema,
    sessionKey: z.string(),
    occurredAt: ISO_DATETIME,
    procedureId: z.string().optional(),
  }),
};

const OutputSchema = {
  success: z.boolean(),
  episodeId: z.string().optional(),
};

export const memoryEpisodicAppend: Tool = {
  name: "memory_episodic_append",
  register(server) {
    server.registerTool(
      "memory_episodic_append",
      {
        title: "Append episodic summary",
        description: "Persist an LLM-written conversation summary tied to an identity + session.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ externalId, summary, metadata }) => {
        const identity = store.state.identities[externalId];
        if (!identity) return toolError("identity_not_found", `unknown externalId ${externalId}`);
        if (identity.mergedInto) {
          return toolError(
            "identity_merged",
            `externalId ${externalId} was merged`,
            { mergedInto: identity.mergedInto },
          );
        }
        const id = episodeId();
        const episode = {
          id,
          summary,
          channelKind: metadata.channelKind,
          sessionKey: metadata.sessionKey,
          occurredAt: metadata.occurredAt,
          ...(metadata.procedureId !== undefined ? { procedureId: metadata.procedureId } : {}),
        };
        const list = store.state.episodes[externalId] ?? [];
        list.push(episode);
        // Retention trim (MCP-AUDIT #18), oldest-first. Not a caller error — the
        // append is valid — so it is logged rather than returned. Bounds both the
        // state file and the per-commit re-serialize cost.
        if (list.length > MAX_EPISODES_PER_IDENTITY) {
          const dropped = list.splice(0, list.length - MAX_EPISODES_PER_IDENTITY);
          log.warn(
            { externalId, dropped: dropped.length, cap: MAX_EPISODES_PER_IDENTITY },
            "episode retention cap reached; dropped oldest",
          );
        }
        store.state.episodes[externalId] = list;
        const failed = commitOrError();
        if (failed) return failed;
        const data = { success: true, episodeId: id };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default memoryEpisodicAppend;
