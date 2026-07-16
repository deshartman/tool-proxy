import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";
import { store } from "../state.js";

// Assist a merge decision: dump both identities' aliases + resolved bags so
// an LLM (or a human via LLM) can eyeball whether the merge is safe.
// Consumers call this BEFORE identity_merge; the answer is advisory only.
export const mergeReview: Prompt = {
  name: "merge_review",
  register(server) {
    server.registerPrompt(
      "merge_review",
      {
        description: "Assemble a side-by-side view of two candidate identities so a reviewer (LLM or human) can green-light identity_merge.",
        argsSchema: {
          winnerExternalId: z.string(),
          loserExternalId: z.string(),
        },
      },
      ({ winnerExternalId, loserExternalId }) => {
        const winner = store.state.identities[winnerExternalId];
        const loser = store.state.identities[loserExternalId];
        const dump = (label: string, id: string) => {
          const row = store.state.identities[id];
          const cache = store.state.semanticCache[id];
          if (!row) return `${label} (${id}): UNKNOWN identity`;
          const aliases = row.aliases.map((a) => `    - ${a.channel}: ${a.value}`).join("\n");
          const resolved = JSON.stringify(cache?.resolved ?? {}, null, 2);
          return [
            `${label} (${id}):`,
            "  aliases:",
            aliases || "    (none)",
            "  resolved:",
            `    ${resolved.split("\n").join("\n    ")}`,
          ].join("\n");
        };
        const text = [
          "Review whether these two identities should be merged. Focus on evidence they refer to the same real person.",
          "",
          dump("WINNER", winnerExternalId),
          "",
          dump("LOSER (will be tombstoned)", loserExternalId),
          "",
          "Respond with either APPROVE (one sentence why) or REJECT (one sentence why, and which additional signal would change your mind).",
          winner && loser ? "" : "\nNote: one of the identities is unknown — treat that as an automatic REJECT.",
        ].join("\n");
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text },
            },
          ],
        };
      },
    );
  },
};

export default mergeReview;
