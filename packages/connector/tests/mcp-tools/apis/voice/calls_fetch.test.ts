import { describe, it, expect, vi } from "vitest";

import { callsFetch } from "../../../../../../mcp/bundled/twilio/tools/voice/calls_fetch.js";
import type { TwilioClient } from "../../../../../../mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(call: Record<string, unknown>): TwilioClient {
  return {
    calls: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(call),
    }),
  } as unknown as TwilioClient;
}

describe("apis.calls_fetch handler", () => {
  it("projects the SDK Call resource through outputSchema", async () => {
    const tool = callsFetch(
      fakeClient({
        sid: "CAxyz",
        status: "completed",
        direction: "outbound-api",
        to: "+15550001111",
        from: "+15550009999",
        duration: "42",
        startTime: new Date("2026-06-19T10:00:00Z"),
        endTime: new Date("2026-06-19T10:00:42Z"),
        price: "-0.01",
        priceUnit: "USD",
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ sid: "CAxyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      duration: string | null;
      priceUnit: string | null;
    };
    expect(parsed.sid).toBe("CAxyz");
    expect(parsed.duration).toBe("42");
    expect(parsed.priceUnit).toBe("USD");
  });
});
