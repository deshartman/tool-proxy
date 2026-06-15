import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

export const voiceTranscriptionStart: Tool = {
  name: "voice_transcription_start",
  register(server) {
    server.registerTool(
      "voice_transcription_start",
      {
        description:
          "Build a TwiML document that begins real-time transcription on the live call. Returns a <Response> with <Start><Transcription/></Start>. Pair the same `name` with voice_transcription_stop.",
        inputSchema: {
          name: z
            .string()
            .optional()
            .describe(
              "Friendly name identifying this transcription session — used to stop it later.",
            ),
          languageCode: z
            .string()
            .optional()
            .describe("BCP-47 language tag, e.g. 'en-US'."),
          statusCallbackUrl: z
            .string()
            .optional()
            .describe(
              "Webhook URL that receives transcript events (started, content, stopped, error).",
            ),
          partialResults: z
            .boolean()
            .optional()
            .describe("Stream interim transcripts in addition to final ones."),
          intelligenceService: z
            .string()
            .optional()
            .describe("SID or unique name of a Voice Intelligence service to apply."),
        },
      },
      async ({ name, languageCode, statusCallbackUrl, partialResults, intelligenceService }) => {
        const r = new VoiceResponse();
        const attrs: Record<string, unknown> = {};
        if (name) attrs.name = name;
        if (languageCode) attrs.languageCode = languageCode;
        if (statusCallbackUrl) attrs.statusCallbackUrl = statusCallbackUrl;
        if (partialResults !== undefined) attrs.partialResults = partialResults;
        if (intelligenceService) attrs.intelligenceService = intelligenceService;
        r.start().transcription(attrs);
        return {
          content: [{ type: "text", text: r.toString() }],
        };
      },
    );
  },
};
