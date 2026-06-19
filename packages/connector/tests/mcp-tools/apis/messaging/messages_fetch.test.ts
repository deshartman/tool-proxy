import { describe, it, expect, vi } from "vitest";

import { messagesFetch } from "@mcp/bundled/twilio/tools/messaging/messages_fetch.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(message: Record<string, unknown>): TwilioClient {
  return {
    messages: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(message),
    }),
  } as unknown as TwilioClient;
}

describe("apis.messages_fetch handler", () => {
  it("projects the SDK Message through outputSchema", async () => {
    const tool = messagesFetch(
      fakeClient({
        sid: "SMxyz",
        status: "delivered",
        to: "+15550001111",
        from: "+15550009999",
        body: "hello",
        dateSent: new Date("2026-06-19T10:00:00Z"),
        errorCode: null,
        errorMessage: null,
      }),
    );
    const reg = captureRegistration(tool);
    const result = asToolResult(await reg.handler({ sid: "SMxyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      status: string;
      errorCode: number | null;
    };
    expect(parsed.sid).toBe("SMxyz");
    expect(parsed.status).toBe("delivered");
    expect(parsed.errorCode).toBeNull();
  });
});
