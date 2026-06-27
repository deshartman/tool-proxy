import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

// TwiML-builder projection: the rendered XML. Procedure authors usually
// feed it straight into calls_create.twiml or a webhook response.
const OutputSchema = {
  twiml: z.string().describe("Complete <Response> TwiML XML."),
};

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
          outputSchema: OutputSchema,
        },
        async ({ text, voice, language, loop }) => {
          const response = new VoiceResponse();
          const attrs: Record<string, unknown> = {};
          if (voice) attrs.voice = voice;
          if (language) attrs.language = language;
          if (loop !== undefined) attrs.loop = loop;
          response.say(attrs, text);
          const xml = response.toString();
          return {
            structuredContent: { twiml: xml },
            content: [{ type: "text", text: xml }],
          };
        },
      );
    },
  };
}
