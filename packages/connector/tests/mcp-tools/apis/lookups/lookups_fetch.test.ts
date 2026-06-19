import { describe, it, expect, vi } from "vitest";

import { lookupsFetch } from "../../../../../../mcp/bundled/twilio/tools/lookups/lookups_fetch.js";
import type { TwilioClient } from "../../../../../../mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(result: Record<string, unknown>): TwilioClient {
  return {
    lookups: {
      v2: {
        phoneNumbers: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(result),
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.lookups_fetch handler", () => {
  it("projects the Lookup result through outputSchema", async () => {
    const tool = lookupsFetch(
      fakeClient({
        phoneNumber: "+15550001111",
        countryCode: "US",
        nationalFormat: "(555) 000-1111",
        valid: true,
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ phone_number: "+15550001111" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      phoneNumber: string;
      valid: boolean;
    };
    expect(parsed.valid).toBe(true);
  });
});
