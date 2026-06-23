import { describe, it, expect, vi } from "vitest";

import { segmentProfileExternalIds } from "@mcp/bundled/twilio/tools/segment/segment_profile_external_ids.js";
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

describe("apis.segment_profile_external_ids handler", () => {
  it("returns the linked external ids list verbatim", async () => {
    const client = fakeClient({
      getExternalIds: vi.fn().mockResolvedValue({
        externalIds: [
          { type: "phone", id: "+15550001111", collection: "users", created_at: "2026-01-01T00:00:00Z" },
          { type: "email", id: "ada@example.com", collection: "users" },
        ],
      }),
    });
    const reg = captureRegistration(segmentProfileExternalIds(client));
    const result = asToolResult(
      await reg.handler({ id_type: "phone", value: "+15550001111" }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      found: boolean;
      externalIds: Array<{ type: string; id: string }>;
    };
    expect(parsed.found).toBe(true);
    expect(parsed.externalIds.map((x) => x.type).sort()).toEqual(["email", "phone"]);
  });
});
