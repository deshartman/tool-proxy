import { describe, it, expect, vi } from "vitest";

import { contentTemplatesFetch } from "@mcp/bundled/twilio/tools/messaging/content_templates_fetch.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(content: Record<string, unknown>): TwilioClient {
  return {
    content: {
      v1: {
        contents: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(content),
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.content_templates_fetch handler", () => {
  it("projects the Content template summary through outputSchema", async () => {
    const tool = contentTemplatesFetch(
      fakeClient({
        sid: "HXxyz",
        friendlyName: "shipping_update",
        language: "en",
        variables: { 1: "name", 2: "tracking" },
        types: { "twilio/text": { body: "Hi {{1}}, tracking {{2}}" } },
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ sid: "HXxyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      friendlyName: string | null;
      variables: unknown;
      types: unknown;
    };
    expect(parsed.sid).toBe("HXxyz");
    expect(parsed.friendlyName).toBe("shipping_update");
    expect(parsed.variables).toEqual({ 1: "name", 2: "tracking" });
  });
});
