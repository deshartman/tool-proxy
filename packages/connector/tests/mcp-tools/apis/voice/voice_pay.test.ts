import { describe, it, expect } from "vitest";

import { voicePay } from "@mcp/bundled/twilio/voice/tools/voice_pay.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

describe("apis.voice_pay handler", () => {
  it("renders <Pay> TwiML and projects it through outputSchema", async () => {
    const reg = captureRegistration(voicePay());
    const result = asToolResult(
      await reg.handler({
        chargeAmount: "10.00",
        currency: "USD",
      }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      twiml: string;
    };
    expect(parsed.twiml).toBe(result.content[0].text);
    expect(parsed.twiml).toMatch(/<Pay[^>]*chargeAmount="10.00"/);
  });
});
