import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

export function voicePlay(): Tool {
  return {
    name: "voice_play",
    register(server) {
      server.registerTool(
        "voice_play",
        {
          description:
            "Build a TwiML document that plays an audio file or DTMF tones. Returns a complete <Response> ready to pass to calls_create.twiml or a webhook.",
          inputSchema: {
            url: z
              .string()
              .optional()
              .describe(
                "URL of the audio file to play (https://…). Either url or digits must be provided.",
              ),
            digits: z
              .string()
              .optional()
              .describe(
                "DTMF tones to play, e.g. '1234' or 'ww1234' (w is a 0.5s pause). Use instead of url.",
              ),
            loop: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Times to repeat. 0 means loop until the call ends."),
          },
        },
        async ({ url, digits, loop }) => {
          if (!url && !digits) {
            throw new Error("Provide either url or digits");
          }
          const response = new VoiceResponse();
          const attrs: Record<string, unknown> = {};
          if (digits) attrs.digits = digits;
          if (loop !== undefined) attrs.loop = loop;
          response.play(attrs, url);
          return {
            content: [{ type: "text", text: response.toString() }],
          };
        },
      );
    },
  };
}
