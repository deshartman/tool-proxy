import { describe, it, expect } from "vitest";

import { voicePlay } from "../../../../../../mcp/bundled/twilio/tools/voice/voice_play.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

describe("apis.voice_play handler", () => {
  it("renders <Play> TwiML and projects it through outputSchema", async () => {
    const reg = captureRegistration(voicePlay());
    const result = asToolResult(
      await reg.handler({ url: "https://example.com/clip.mp3", loop: 2 }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    expect(parsed.twiml).toBe(result.content[0].text);
    expect(parsed.twiml).toMatch(/<Play[^>]*>https:\/\/example.com\/clip.mp3<\/Play>/);
  });
});
