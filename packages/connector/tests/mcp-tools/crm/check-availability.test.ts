import { describe, it, expect, afterEach, vi } from "vitest";

import { checkAvailability } from "../../../../../mcp/local/crm/tools/check-availability.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// check_availability always 200s — `available` is the discriminator, not
// HTTP status. Both available and unavailable returns get structuredContent
// because neither is an MCP-level error.

describe("crm.check_availability handler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns structuredContent matching outputSchema for an available slot", async () => {
    const reg = captureRegistration(checkAvailability);
    expect(reg.outputSchema).toBeDefined();

    const body = {
      requested: "2026-06-22T14:00:00.000Z",
      available: true,
      daysFromNow: 3,
      isSameDay: false,
      technician: "Sam Reyes",
      suggestions: [],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ start: body.requested }));
    expect(result.structuredContent).toEqual(body);
    const schema = asZodObject(reg.outputSchema);
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
  });

  it("returns structuredContent including reason+suggestions for an unavailable slot", async () => {
    const reg = captureRegistration(checkAvailability);
    const body = {
      requested: "2026-06-22T14:00:00.000Z",
      available: false,
      reason: "slot_taken",
      daysFromNow: 3,
      isSameDay: false,
      technician: "Sam Reyes",
      suggestions: ["2026-06-22T15:00:00.000Z", "2026-06-22T16:00:00.000Z", "2026-06-23T09:00:00.000Z"],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ start: body.requested }));
    expect(result.structuredContent).toEqual(body);
    const schema = asZodObject(reg.outputSchema);
    const parsed = schema.parse(result.structuredContent) as {
      available: boolean;
      reason?: string;
      suggestions: string[];
    };
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe("slot_taken");
    expect(parsed.suggestions).toHaveLength(3);
  });
});
