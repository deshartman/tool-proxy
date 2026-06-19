import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { emailSend } from "@mcp/bundled/twilio/tools/email/email_send.js";
import type { SendGridClientProvider } from "@mcp/bundled/twilio/sendgrid-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeProvider(headers: Record<string, string>, statusCode: number): SendGridClientProvider {
  // SendGrid client.request returns [response, body]; only the response
  // headers + statusCode are read on the success path here.
  const client = {
    request: vi.fn().mockResolvedValue([
      { headers, statusCode },
      {},
    ]),
  };
  return (() => client) as unknown as SendGridClientProvider;
}

describe("apis.email_send handler", () => {
  beforeEach(() => {
    vi.stubEnv("SENDGRID_FROM_EMAIL", "ops@example.com");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { messageId, statusCode } matching outputSchema", async () => {
    const provider = fakeProvider({ "x-message-id": "MSG_xyz" }, 202);
    const reg = captureRegistration(emailSend(provider));
    const result = asToolResult(
      await reg.handler({
        to: "user@example.com",
        subject: "hi",
        text: "hello",
      }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      messageId: string;
      statusCode: number;
    };
    expect(parsed.messageId).toBe("MSG_xyz");
    expect(parsed.statusCode).toBe(202);
  });
});
