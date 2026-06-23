import { describe, it, expect, vi } from "vitest";

import { segmentIdentify } from "@mcp/bundled/twilio/tools/segment/segment_identify.js";
import type { SegmentTrackerProvider, SegmentAnalytics } from "@mcp/bundled/twilio/segment-tracker.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../../helpers/register-tool.js";

function fakeTracker(messageId: string | undefined): { provider: SegmentTrackerProvider; identifyMock: ReturnType<typeof vi.fn> } {
  // Mirror the v3 SDK's identify(params, callback) shape. Callback is
  // (err?, ctx?) => void; ctx.event.messageId is what the tool reads.
  const identifyMock = vi.fn((params: unknown, callback?: (err?: unknown, ctx?: unknown) => void) => {
    callback?.(undefined, { event: { messageId } } as never);
  });
  const fake = { identify: identifyMock } as unknown as SegmentAnalytics;
  return { provider: () => fake, identifyMock };
}

describe("apis.segment_identify handler", () => {
  it("delivers identify with userId and surfaces messageId", async () => {
    const { provider, identifyMock } = fakeTracker("msg_abc");
    const reg = captureRegistration(segmentIdentify(provider));
    const result = asToolResult(
      await reg.handler({ userId: "u_42", traits: { plan: "premium" } }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      delivered: boolean;
      messageId?: string;
    };
    expect(parsed.delivered).toBe(true);
    expect(parsed.messageId).toBe("msg_abc");

    // Sanity: the tool passed userId through and didn't accidentally include
    // anonymousId on the wire.
    const sentParams = identifyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentParams.userId).toBe("u_42");
    expect(sentParams.anonymousId).toBeUndefined();
    expect(sentParams.traits).toEqual({ plan: "premium" });
  });

  it("rejects when neither userId nor anonymousId is supplied", async () => {
    const { provider } = fakeTracker(undefined);
    const reg = captureRegistration(segmentIdentify(provider));
    await expect(reg.handler({ traits: {} })).rejects.toThrow(/userId or anonymousId/);
  });

  it("rejects when both userId and anonymousId are supplied", async () => {
    const { provider } = fakeTracker(undefined);
    const reg = captureRegistration(segmentIdentify(provider));
    await expect(
      reg.handler({ userId: "u_1", anonymousId: "a_1" }),
    ).rejects.toThrow(/not both/);
  });
});
