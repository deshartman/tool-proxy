import { describe, it, expect } from "vitest";

import { voiceDial } from "@mcp/bundled/twilio/tools/voice/voice_dial.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

describe("apis.voice_dial handler", () => {
  it("renders <Dial><Number> TwiML and projects it through outputSchema", async () => {
    const reg = captureRegistration(voiceDial());
    const result = asToolResult(
      await reg.handler({
        callerId: "+15551239999",
        numbers: [{ number: "+15550001111" }],
      }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    expect(parsed.twiml).toBe(result.content[0].text);
    expect(parsed.twiml).toMatch(/<Dial[^>]*callerId="\+15551239999"/);
    expect(parsed.twiml).toContain("+15550001111");
  });
});
