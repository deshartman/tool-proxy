import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

export function voiceSay(): Tool {
  return {
    name: "voice_say",
    register(server) {
      server.registerTool(
        "voice_say",
        {
          description:
            "Build a TwiML document with a single <Say> verb. Returns a complete <Response> ready to pass to calls_create.twiml or to a webhook response.",
          inputSchema: {
            text: z.string().min(1).describe("The text to read aloud."),
            voice: z
              .string()
              .optional()
              .describe(
                "TTS voice. Examples: 'Polly.Joanna', 'Polly.Matthew', 'man', 'woman', 'alice'. Defaults to Twilio's account default.",
              ),
            language: z
              .string()
              .optional()
              .describe("BCP-47 language tag, e.g. 'en-US', 'es-MX', 'fr-FR'."),
            loop: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Times to repeat. 0 means loop until the call ends."),
          },
        },
        async ({ text, voice, language, loop }) => {
          const r = new VoiceResponse();
          const attrs: Record<string, unknown> = {};
          if (voice) attrs.voice = voice;
          if (language) attrs.language = language;
          if (loop !== undefined) attrs.loop = loop;
          r.say(attrs, text);
          return {
            content: [{ type: "text", text: r.toString() }],
          };
        },
      );
    },
  };
}
