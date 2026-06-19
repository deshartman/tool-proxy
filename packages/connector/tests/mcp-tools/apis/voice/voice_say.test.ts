import { describe, it, expect } from "vitest";

import { voiceSay } from "@mcp/bundled/twilio/tools/voice/voice_say.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

// TwiML builders take no client — voiceSay() returns a Tool directly.
// The schema is { twiml: string }; the handler renders <Response><Say>...
// and returns it as both content[0].text and structuredContent.twiml.

describe("apis.voice_say handler", () => {
  it("returns structuredContent.twiml that round-trips through outputSchema", async () => {
    const reg = captureRegistration(voiceSay());
    expect(reg.outputSchema).toBeDefined();

    const result = asToolResult(await reg.handler({ text: "Hello", voice: "Polly.Joanna" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    // structuredContent and content[0].text must serialize to the same data.
    expect(parsed.twiml).toBe(result.content[0].text);
    // Sanity: the TwiML actually contains a <Say> verb with the input text.
    expect(parsed.twiml).toMatch(/<Response>.*<Say[^>]*>Hello<\/Say>.*<\/Response>/s);
  });
});
