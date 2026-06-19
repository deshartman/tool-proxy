import { describe, it, expect, vi } from "vitest";

import { messagingServicesFetch } from "../../../../../../mcp/bundled/twilio/tools/messaging/messaging_services_fetch.js";
import type { TwilioClient } from "../../../../../../mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(service: Record<string, unknown>): TwilioClient {
  return {
    messaging: {
      v1: {
        services: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(service),
        }),
      },
    },
  } as unknown as TwilioClient;
}

describe("apis.messaging_services_fetch handler", () => {
  it("projects the Messaging Service summary through outputSchema", async () => {
    const tool = messagingServicesFetch(
      fakeClient({
        sid: "MGxyz",
        friendlyName: "primary",
        inboundRequestUrl: "https://x/sms",
        fallbackUrl: null,
        statusCallback: "https://x/status",
        stickySender: true,
        smartEncoding: true,
        scanMessageContent: "inherit",
        useInboundWebhookOnNumber: false,
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ sid: "MGxyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      friendlyName: string | null;
      stickySender: boolean | null;
    };
    expect(parsed.sid).toBe("MGxyz");
    expect(parsed.friendlyName).toBe("primary");
    expect(parsed.stickySender).toBe(true);
  });
});
