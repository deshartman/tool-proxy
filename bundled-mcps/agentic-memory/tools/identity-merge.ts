import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { ISO_DATETIME } from "../schemas.js";
import { aliasKey, commitOrError, store } from "../state.js";
import { toolError } from "../errors.js";

const InputSchema = {
  winner: z.string(),
  loser: z.string(),
  mergedAt: ISO_DATETIME,
};

const OutputSchema = {
  success: z.boolean(),
  aliasesMigrated: z.number().int().min(0),
};

// §4.6 semantics: loser aliases move to winner (or drop if winner already
// has an equivalent alias); loser is tombstoned with mergedInto set. Post-
// merge lookups by externalId=loser fail with identity_merged. Semantic
// cache and episodes are NOT touched here — the orchestrator calls
// memory_semantic_merge_identities separately.
export const identityMerge: Tool = {
  name: "identity_merge",
  register(server) {
    server.registerTool(
      "identity_merge",
      {
        title: "Collapse loser identity into winner",
        description: "Migrates loser aliases to winner and tombstones loser. Subsequent externalId=loser lookups raise identity_merged.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ winner, loser, mergedAt: _mergedAt }) => {
        if (winner === loser) {
          return toolError("invalid_identifier", "winner and loser must differ");
        }
        const winnerRow = store.state.identities[winner];
        const loserRow = store.state.identities[loser];
        if (!winnerRow) return toolError("identity_not_found", `winner externalId ${winner} unknown`);
        if (!loserRow) return toolError("identity_not_found", `loser externalId ${loser} unknown`);
        if (winnerRow.mergedInto) {
          return toolError(
            "identity_merged",
            `winner ${winner} was itself merged`,
            { mergedInto: winnerRow.mergedInto },
          );
        }
        if (loserRow.mergedInto) {
          return toolError(
            "identity_merged",
            `loser ${loser} was already merged`,
            { mergedInto: loserRow.mergedInto },
          );
        }

        let aliasesMigrated = 0;
        for (const alias of loserRow.aliases) {
          const key = aliasKey(alias.channel, alias.value);
          const dupe = winnerRow.aliases.some((w) => w.channel === alias.channel && w.value === alias.value);
          if (!dupe) {
            winnerRow.aliases.push(alias);
            aliasesMigrated += 1;
          }
          store.state.aliasIndex[key] = winner;
        }
        loserRow.aliases = [];
        loserRow.mergedInto = winner;
        const failed = commitOrError();
        if (failed) return failed;

        const data = { success: true, aliasesMigrated };
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  },
};

export default identityMerge;
