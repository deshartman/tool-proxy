import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getCustomer } from "../../../../../mcp/local/crm/tools/get-customer.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// S3a — pin the convention: every CRM handler returns BOTH content[] AND
// structuredContent on success, AND structuredContent round-trips through
// the declared outputSchema. If a future edit drops structuredContent or
// drifts the success shape, this test fails before the manifest validator
// (which only checks declaration, not shape).

describe("crm.get_customer handler", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // Mock fetch to the mock-customers service. Each test stubs it.
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns structuredContent matching the declared outputSchema on the success path", async () => {
    const reg = captureRegistration(getCustomer);
    expect(reg.outputSchema).toBeDefined();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          customer: {
            name: "Ada",
            surname: "Lovelace",
            phone: "+15551239999",
            email: "ada@example.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({ customer_phone: "+15551239999" }),
    );

    expect(result.structuredContent).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    // Round-trip the structuredContent through the declared schema —
    // pins rule #3 (machine-shape sibling matches the schema).
    const schema = asZodObject(reg.outputSchema);
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
  });

  it("normalises missing phone/email fields to null in the projection", async () => {
    const reg = captureRegistration(getCustomer);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ customer: { name: "Ada", surname: "Lovelace" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ customer_phone: "+15550001111" }));
    const schema = asZodObject(reg.outputSchema);
    const parsed = schema.parse(result.structuredContent) as {
      name: string;
      surname: string;
      phone: string | null;
      email: string | null;
    };
    expect(parsed.phone).toBeNull();
    expect(parsed.email).toBeNull();
  });

  it("does NOT set structuredContent on the no_customer error envelope (plan rule #5)", async () => {
    const reg = captureRegistration(getCustomer);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no_customer" }), { status: 404 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({ customer_phone: "+15559998888" }),
    );
    // Error envelopes flow through content[] only — structuredContent on
    // an error path would fail SDK validation against the success schema.
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("no_customer");
  });
});
