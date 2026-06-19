import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { messagesCreate } from "../../../../../../mcp/bundled/twilio/tools/messaging/messages_create.js";
import type { TwilioClient } from "../../../../../../mcp/bundled/twilio/twilio-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(message: { sid: string; status: string }): TwilioClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(message),
    },
  } as unknown as TwilioClient;
}

describe("apis.messages_create handler", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550009999");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { sid, status, channel } matching outputSchema", async () => {
    const tool = messagesCreate(fakeClient({ sid: "SMxyz", status: "queued" }));
    const reg = captureRegistration(tool);
    const result = asToolResult(
      await reg.handler({ channel: "sms", to: "+15550001111", body: "hello" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      sid: string;
      status: string;
      channel: string;
    };
    expect(parsed.sid).toBe("SMxyz");
    expect(parsed.status).toBe("queued");
    expect(parsed.channel).toBe("sms");
    expect(result.content[0].text).toContain("SMxyz");
  });
});
