import { describe, it, expect, afterEach, vi } from "vitest";

import { verifyServicesFetch } from "@mcp/bundled/twilio/tools/verify/verify_services_fetch.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(service: Record<string, unknown>): TwilioClient {
  return {
    verify: {
      v2: {
        services: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(service),
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.verify_services_fetch handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects the Verify Service summary through outputSchema", async () => {
    const tool = verifyServicesFetch(
      fakeClient({
        sid: "VAxyz",
        friendlyName: "verify-mcp",
        codeLength: 6,
        lookupEnabled: false,
        skipSmsToLandlines: true,
        dtmfInputRequired: false,
        ttsName: "alice",
        psd2Enabled: false,
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ sid: "VAxyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      codeLength: number | null;
    };
    expect(parsed.sid).toBe("VAxyz");
    expect(parsed.codeLength).toBe(6);
  });
});
