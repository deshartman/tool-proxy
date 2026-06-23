import { describe, it, expect, vi } from "vitest";

import { segmentProfileEvents } from "@mcp/bundled/twilio/tools/segment/segment_profile_events.js";
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

describe("apis.segment_profile_events handler", () => {
  it("surfaces the paging cursor in structuredContent", async () => {
    const client = fakeClient({
      getEvents: vi.fn().mockResolvedValue({
        events: [
          { event: "Order Completed", timestamp: "2026-06-01T12:00:00Z", properties: { value: 42 } },
        ],
        cursor: { has_more: true, next: "page2" },
      }),
    });
    const reg = captureRegistration(segmentProfileEvents(client));
    const result = asToolResult(
      await reg.handler({ id_type: "user_id", value: "u_123", limit: 1 }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      found: boolean;
      events: Array<{ event: string }>;
      cursor?: { hasMore: boolean; next?: string };
    };
    expect(parsed.found).toBe(true);
    expect(parsed.events[0].event).toBe("Order Completed");
    expect(parsed.cursor).toEqual({ hasMore: true, next: "page2" });
  });
});
