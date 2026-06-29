import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SegmentTrackerProvider } from "../../segment-tracker.js";

const OutputSchema = {
  delivered: z.boolean().describe("True when Segment accepted the event (callback fired with no error)."),
  messageId: z.string().optional().describe("Segment-assigned message id; correlates with the source's debugger view."),
};

export function segmentIdentify(getTracker: SegmentTrackerProvider): Tool {
  return {
    name: "segment_identify",
    register(server) {
      server.registerTool(
        "segment_identify",
        {
          title: "Identify Segment Profile",
          description:
            "Upserts traits onto a Segment profile (`identify` call). Provide exactly one of userId / anonymousId. Awaits delivery before returning so the tool result reflects whether Segment accepted the event.",
          inputSchema: {
            userId: z.string().optional().describe("Known user id. Required if anonymousId is not provided."),
            anonymousId: z.string().optional().describe("Anonymous id (typically a UUID). Required if userId is not provided."),
            traits: z.record(z.string(), z.unknown()).optional().describe("Trait key/value pairs to upsert onto the profile."),
            context: z.record(z.string(), z.unknown()).optional().describe("Optional Segment context object (page, app, device, etc)."),
          },
          outputSchema: OutputSchema,
        },
        async ({ userId, anonymousId, traits, context }) => {
          if (!userId && !anonymousId) {
            throw new Error("Provide either userId or anonymousId");
          }
          if (userId && anonymousId) {
            throw new Error("Provide either userId OR anonymousId, not both");
          }

          const analytics = getTracker();
          const messageId = await new Promise<string | undefined>((resolve, reject) => {
            const params: Record<string, unknown> = { traits, context };
            if (userId) params.userId = userId;
            if (anonymousId) params.anonymousId = anonymousId;
            // SDK's identify is fire-and-forget; the callback fires once the
            // event has been dispatched (flushAt: 1 in segment-tracker.ts
            // forces immediate flush). messageId surfaces from ctx.event.
            analytics.identify(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              params as any,
              (err, ctx) => {
                if (err) return reject(err instanceof Error ? err : new Error(String(err)));
                const evt = ctx?.event as { messageId?: string } | undefined;
                resolve(evt?.messageId);
              },
            );
          });

          const data = { delivered: true, messageId };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `identify delivered messageId=${messageId ?? "(none)"}` }],
          };
        },
      );
    },
  };
}
