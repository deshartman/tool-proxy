import { describe, it, expect, afterEach, vi } from "vitest";

import { verifySend } from "@mcp/bundled/twilio/verify/tools/verify_send.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(verification: Record<string, unknown>): TwilioClient {
  return {
    verify: {
      v2: {
        services: vi.fn().mockReturnValue({
          verifications: { create: vi.fn().mockResolvedValue(verification) },
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.verify_send handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { sid, status, channel } matching outputSchema", async () => {
    const tool = verifySend(
      fakeClient({ sid: "VEabc", status: "pending", channel: "sms" }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(
      await reg.handler({ to: "+15550001111", channel: "sms", serviceSid: "VAxyz" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      status: string;
      channel: string;
    };
    expect(parsed.sid).toBe("VEabc");
    expect(parsed.channel).toBe("sms");
  });
});
