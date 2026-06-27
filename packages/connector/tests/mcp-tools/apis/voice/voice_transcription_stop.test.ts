import { describe, it, expect } from "vitest";

import { voiceTranscriptionStop } from "@mcp/bundled/twilio/voice/tools/voice_transcription_stop.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

describe("apis.voice_transcription_stop handler", () => {
  it("renders <Stop><Transcription> and projects it through outputSchema", async () => {
    const reg = captureRegistration(voiceTranscriptionStop());
    const result = asToolResult(await reg.handler({ name: "session-1" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    expect(parsed.twiml).toBe(result.content[0].text);
    expect(parsed.twiml).toMatch(/<Stop>.*<Transcription[^>]*name="session-1"/s);
  });
});
