import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";
import { ChannelSchema } from "../schemas.js";

// Compose the prompt an agent uses AT THE END of a session to produce the
// summary that gets written back via memory_episodic_append. Keeps the
// summarisation guidance consistent across procedures — swap this prompt to
// change the shape of episodic memory across the whole platform.
export const summarizeEpisode: Prompt = {
  name: "summarize_episode",
  register(server) {
    server.registerPrompt(
      "summarize_episode",
      {
        description: "Ask an LLM to produce a 2–3 sentence episode summary suitable for memory_episodic_append.",
        argsSchema: {
          transcript: z.string().describe("Raw session transcript (turns preserved)."),
          channelKind: ChannelSchema,
        },
      },
      ({ transcript, channelKind }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `You just concluded a session on the ${channelKind} channel. Write a 2–3 sentence summary suitable for future recall.`,
                "",
                "Constraints:",
                "  - Third-person; no salutations; no PII beyond identifiers already in the transcript.",
                "  - Lead with what the customer wanted; end with what was decided or the next step.",
                "  - Neutral tone — this feeds a retrieval system, not marketing copy.",
                "",
                "Transcript:",
                transcript,
                "",
                "Respond with the summary only — no preface, no bullet lists.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  },
};

export default summarizeEpisode;
