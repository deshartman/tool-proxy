import { z } from "zod";
import type { Prompt } from "@gtmi/toolproxy-connector/sdk";

// Session-opening prompt: pull the caller's record + recent history so the
// agent can greet them with context rather than asking them to re-identify.
// Complements the session envelope keys (channel_from, channel_to, …) which
// procedure runtimes inject into every tool call — this prompt tells the
// model to USE channel_from as the lookup key instead of asking for it.
export const identifyCaller: Prompt = {
  name: "identify_caller",
  register(server) {
    server.registerPrompt(
      "identify_caller",
      {
        description:
          "Bootstraps a session: fetches the caller's customer record and recent activity so the agent can greet them with context.",
        argsSchema: {
          callerPhone: z
            .string()
            .describe("Caller's E.164 phone (usually channel_from off the session envelope)."),
        },
      },
      ({ callerPhone }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `A caller is on the line at ${callerPhone}. Prepare context BEFORE speaking.`,
                "",
                "Sequence:",
                `  1. Call get_customer({ customer_phone: "${callerPhone}" }) to load their profile.`,
                `  2. Call get_recent({ phone: "${callerPhone}" }) to load their recent orders and interactions.`,
                "  3. Open with a greeting that uses the name from step 1 and references the newest item from step 2 (e.g. 'Hi Sam — is this about last week's repair?').",
                "",
                "If get_customer returns no match, greet neutrally and ask how you can help. Do NOT ask the caller to state their phone number — you already have it.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  },
};

export default identifyCaller;
