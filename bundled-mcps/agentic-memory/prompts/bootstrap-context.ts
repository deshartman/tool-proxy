import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";
import { store } from "../state.js";

// Warm-start an agent with the identity's resolved bag + a handful of most-
// recent episodes. Prompts render a single user-role message; the caller
// (a procedure step) treats this as the system context for a new session.
export const bootstrapContext: Prompt = {
  name: "bootstrap_context",
  register(server) {
    server.registerPrompt(
      "bootstrap_context",
      {
        description: "Prefills an agent's opening turn with the identity's semantic cache and most-recent episodes.",
        argsSchema: {
          externalId: z.string().describe("Identity externalId minted by identity_resolve."),
          includeEpisodes: z.enum(["true", "false"]).optional().describe("Include most-recent 5 episodes (default true)."),
        },
      },
      ({ externalId, includeEpisodes }) => {
        const include = includeEpisodes !== "false";
        const identity = store.state.identities[externalId];
        if (!identity || identity.mergedInto) {
          return {
            messages: [{
              role: "user",
              content: {
                type: "text",
                text: `The identity ${externalId} is not resolvable (unknown or merged). Ask the caller to re-run identity_resolve before starting the session.`,
              },
            }],
          };
        }
        const cache = store.state.semanticCache[externalId];
        const resolved = cache?.resolved ?? {};
        const refs = cache?.sourceRefs ?? [];
        const episodes = include ? (store.state.episodes[externalId] ?? []).slice(-5).reverse() : [];
        const parts: string[] = [
          `You are resuming a session with an existing customer identity (externalId=${externalId}).`,
          "",
          "Aliases on file:",
          ...identity.aliases.map((a) => `  - ${a.channel}: ${a.value} (added ${a.addedAt})`),
          "",
          "Resolved semantic bag:",
          `  ${JSON.stringify(resolved, null, 2).split("\n").join("\n  ")}`,
        ];
        if (refs.length > 0) {
          parts.push("", "Source refs (accumulated across procedures):");
          for (const r of refs) parts.push(`  - ${r.kind}:${r.label}${r.target ? ` → ${r.target}` : ""}`);
        }
        if (include) {
          parts.push("", "Most-recent episodes (newest first):");
          if (episodes.length === 0) parts.push("  (no episodes recorded yet)");
          for (const e of episodes) parts.push(`  - [${e.occurredAt}] (${e.channelKind}) ${e.summary}`);
        }
        parts.push("", "Use this context to greet the customer without asking them to re-identify themselves.");
        return {
          messages: [{
            role: "user",
            content: { type: "text", text: parts.join("\n") },
          }],
        };
      },
    );
  },
};

export default bootstrapContext;
