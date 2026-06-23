import { describe, it, expect, vi } from "vitest";

import { segmentProfileTraits } from "@mcp/bundled/twilio/tools/segment/segment_profile_traits.js";
import type { SegmentProfileClient } from "@mcp/bundled/twilio/segment-profile-client.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeClient(overrides: Partial<SegmentProfileClient> = {}): SegmentProfileClient {
  return {
    getTraits: vi.fn(),
    getEvents: vi.fn(),
    getExternalIds: vi.fn(),
    ...overrides,
  } as SegmentProfileClient;
}

describe("apis.segment_profile_traits handler", () => {
  it("projects a traits payload through outputSchema", async () => {
    const client = fakeClient({
      getTraits: vi.fn().mockResolvedValue({
        traits: { firstName: "Ada", plan: "premium" },
        cursor: { has_more: false },
      }),
    });
    const reg = captureRegistration(segmentProfileTraits(client));
    const result = asToolResult(
      await reg.handler({ id_type: "phone", value: "+15550001111" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      found: boolean;
      traits: Record<string, unknown> | null;
    };
    expect(parsed.found).toBe(true);
    expect(parsed.traits).toEqual({ firstName: "Ada", plan: "premium" });
  });

  it("returns { found: false, traits: null } on profile-not-found", async () => {
    const client = fakeClient({
      getTraits: vi.fn().mockResolvedValue(null),
    });
    const reg = captureRegistration(segmentProfileTraits(client));
    const result = asToolResult(
      await reg.handler({ id_type: "email", value: "missing@example.com" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      found: boolean;
      traits: Record<string, unknown> | null;
    };
    expect(parsed.found).toBe(false);
    expect(parsed.traits).toBeNull();
  });
});
