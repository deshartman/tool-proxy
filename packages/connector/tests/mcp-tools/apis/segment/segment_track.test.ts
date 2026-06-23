import { describe, it, expect, vi } from "vitest";

import { segmentTrack } from "@mcp/bundled/twilio/tools/segment/segment_track.js";
import type { SegmentTrackerProvider, SegmentAnalytics } from "@mcp/bundled/twilio/segment-tracker.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeTracker(messageId: string | undefined): { provider: SegmentTrackerProvider; trackMock: ReturnType<typeof vi.fn> } {
  const trackMock = vi.fn((params: unknown, callback?: (err?: unknown, ctx?: unknown) => void) => {
    callback?.(undefined, { event: { messageId } } as never);
  });
  const fake = { track: trackMock } as unknown as SegmentAnalytics;
  return { provider: () => fake, trackMock };
}

describe("apis.segment_track handler", () => {
  it("delivers track with anonymousId and forwards event + properties", async () => {
    const { provider, trackMock } = fakeTracker("msg_xyz");
    const reg = captureRegistration(segmentTrack(provider));
    const result = asToolResult(
      await reg.handler({
        anonymousId: "anon-42",
        event: "Order Completed",
        properties: { value: 100, currency: "USD" },
      }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      delivered: boolean;
      messageId?: string;
      event: string;
    };
    expect(parsed.delivered).toBe(true);
    expect(parsed.messageId).toBe("msg_xyz");
    expect(parsed.event).toBe("Order Completed");

    const sentParams = trackMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentParams.anonymousId).toBe("anon-42");
    expect(sentParams.event).toBe("Order Completed");
    expect(sentParams.properties).toEqual({ value: 100, currency: "USD" });
  });

  it("rejects when SDK callback fires with an error", async () => {
    const trackMock = vi.fn((_params: unknown, callback?: (err?: unknown, ctx?: unknown) => void) => {
      callback?.(new Error("network down"));
    });
    const fake = { track: trackMock } as unknown as SegmentAnalytics;
    const reg = captureRegistration(segmentTrack(() => fake));
    await expect(
      reg.handler({ userId: "u_1", event: "Test" }),
    ).rejects.toThrow(/network down/);
  });
});
