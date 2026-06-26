import { describe, it, expect, vi } from "vitest";

import { emailSearch } from "@mcp/bundled/twilio/email/tools/email_search.js";
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

describe("apis.email_search handler", () => {
  it("wraps the upstream search result under structuredContent.body", async () => {
    const upstream = { messages: [{ msg_id: "MSG_a" }, { msg_id: "MSG_b" }] };
    const reg = captureRegistration(emailSearch(fakeProvider(upstream)));
    const result = asToolResult(
      await reg.handler({ query: 'to_email="user@example.com"' }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      body: unknown;
    };
    expect(parsed.body).toEqual(upstream);
  });
});
