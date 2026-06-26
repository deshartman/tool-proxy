import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

const OutputSchema = {
  twiml: z.string().describe("Complete <Response> TwiML XML."),
};

export function voiceTranscriptionStop(): Tool {
  return {
    name: "voice_transcription_stop",
    register(server) {
      server.registerTool(
        "voice_transcription_stop",
        {
          description:
            "Build a TwiML document that stops a real-time transcription session started via voice_transcription_start. Returns a <Response> with <Stop><Transcription/></Stop>.",
          inputSchema: {
            name: z
              .string()
              .optional()
              .describe(
                "Friendly name of the transcription session to stop. Must match the name used when starting.",
              ),
          },
          outputSchema: OutputSchema,
        },
        async ({ name }) => {
          const response = new VoiceResponse();
          const attrs: Record<string, unknown> = {};
          if (name) attrs.name = name;
          response.stop().transcription(attrs);
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
