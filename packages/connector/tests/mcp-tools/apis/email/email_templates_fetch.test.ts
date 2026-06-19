import { describe, it, expect, vi } from "vitest";

import { emailTemplatesFetch } from "../../../../../../mcp/bundled/twilio/tools/email/email_templates_fetch.js";
import type { SendGridClientProvider } from "../../../../../../mcp/bundled/twilio/sendgrid-client.js";
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

describe("apis.email_templates_fetch handler", () => {
  it("wraps the single-template response under structuredContent.body", async () => {
    const upstream = { id: "d-xyz", name: "welcome", versions: [] };
    const reg = captureRegistration(emailTemplatesFetch(fakeProvider(upstream)));
    const result = asToolResult(await reg.handler({ templateId: "d-xyz" }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      body: unknown;
    };
    expect(parsed.body).toEqual(upstream);
  });

  it("wraps the list response under structuredContent.body when no templateId", async () => {
    const upstream = { templates: [{ id: "d-1" }, { id: "d-2" }] };
    const reg = captureRegistration(emailTemplatesFetch(fakeProvider(upstream)));
    const result = asToolResult(await reg.handler({}));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      body: unknown;
    };
    expect(parsed.body).toEqual(upstream);
  });
});
