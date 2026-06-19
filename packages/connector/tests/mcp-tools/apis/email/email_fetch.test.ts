import { describe, it, expect, vi } from "vitest";

import { emailFetch } from "@mcp/bundled/twilio/tools/email/email_fetch.js";
import type { SendGridClientProvider } from "@mcp/bundled/twilio/sendgrid-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeProvider(body: unknown): SendGridClientProvider {
  const client = {
    request: vi.fn().mockResolvedValue([{ headers: {}, statusCode: 200 }, body]),
  };
  return (() => client) as unknown as SendGridClientProvider;
}

describe("apis.email_fetch handler", () => {
  it("wraps the upstream body under structuredContent.body", async () => {
    const upstream = { msg_id: "MSG_xyz", events: [{ event_name: "delivered" }] };
    const reg = captureRegistration(emailFetch(fakeProvider(upstream)));
    const result = asToolResult(await reg.handler({ msgId: "MSG_xyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      body: unknown;
    };
    expect(parsed.body).toEqual(upstream);
  });
});
