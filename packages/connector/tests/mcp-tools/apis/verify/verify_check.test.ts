import { describe, it, expect, afterEach, vi } from "vitest";

import { verifyCheck } from "@mcp/bundled/twilio/verify/tools/verify_check.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(check: Record<string, unknown>): TwilioClient {
  return {
    verify: {
      v2: {
        services: vi.fn().mockReturnValue({
          verificationChecks: { create: vi.fn().mockResolvedValue(check) },
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.verify_check handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects the check result through outputSchema", async () => {
    const tool = verifyCheck(
      fakeClient({
        sid: "VEabc",
        status: "approved",
        valid: true,
        to: "+15550001111",
        channel: "sms",
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(
      await reg.handler({ to: "+15550001111", code: "123456", serviceSid: "VAxyz" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      status: string;
      valid: boolean;
    };
    expect(parsed.status).toBe("approved");
    expect(parsed.valid).toBe(true);
  });
});
