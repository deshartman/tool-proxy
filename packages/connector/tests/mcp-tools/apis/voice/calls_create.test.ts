import { describe, it, expect, afterEach, vi } from "vitest";

import { callsCreate } from "@mcp/bundled/twilio/voice/tools/calls_create.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

// Fake TwilioClient: only the path callsCreate exercises (calls.create).
function fakeClient(callResult: { sid: string; status: string }): TwilioClient {
  return {
    calls: {
      create: vi.fn().mockResolvedValue(callResult),
    },
  } as unknown as TwilioClient;
}

describe("apis.calls_create handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { sid, status } structuredContent matching outputSchema", async () => {
    const tool = callsCreate(fakeClient({ sid: "CAxyz", status: "queued" }));
    const reg = captureRegistration(tool);
    const result = asToolResult(
      await reg.handler({
        to: "+15550001111",
        from: "+15550009999",
        twiml: "<Response><Say>Hi</Say></Response>",
      }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      status: string;
    };
    expect(parsed.sid).toBe("CAxyz");
    expect(parsed.status).toBe("queued");
    expect(result.content[0].text).toContain("CAxyz");
  });
});
