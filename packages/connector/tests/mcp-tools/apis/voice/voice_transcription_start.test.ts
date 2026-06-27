import { describe, it, expect } from "vitest";

import { voiceTranscriptionStart } from "@mcp/bundled/twilio/voice/tools/voice_transcription_start.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

describe("apis.voice_transcription_start handler", () => {
  it("renders <Start><Transcription> and projects it through outputSchema", async () => {
    const reg = captureRegistration(voiceTranscriptionStart());
    const result = asToolResult(
      await reg.handler({ name: "session-1", languageCode: "en-US" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    expect(parsed.twiml).toBe(result.content[0].text);
    expect(parsed.twiml).toMatch(/<Start>.*<Transcription[^>]*name="session-1"/s);
  });
});
