import { Analytics } from "@segment/analytics-node";
import { createLogger } from "@mcp-shim/connector/sdk";

// @segment/analytics-node v3 wrapper. Lazy provider so a tool that's never
// invoked never instantiates the SDK (mirrors makeSendGridProvider in
// sendgrid-client.ts). Throws on first use if SEGMENT_WRITE_KEY is missing
// — server.ts gates registration on env presence so this is a defensive
// backstop.
//
// flushAt: 1 forces every identify/track to ship as its own batch, which
// matches the procedure-author mental model "tool returned → write
// happened". The SDK's default flushAt is 15 / flushInterval 10s; that's
// fine for a long-running web app but wrong for a procedure step that
// returns to the controller once the tool resolves.
//
// We expose Analytics directly rather than re-wrapping each method —
// per-tool code calls `analytics.identify({...}, cb)` / `analytics.track`
// with the v3 callback shape and resolves on the callback.

export type SegmentAnalytics = Analytics;
export type SegmentTrackerProvider = () => SegmentAnalytics;

const log = createLogger("segment-tracker");

export function makeSegmentTracker(env: NodeJS.ProcessEnv = process.env): SegmentTrackerProvider {
  let instance: Analytics | null = null;
  return () => {
    if (instance) return instance;
    const writeKey = env.SEGMENT_WRITE_KEY;
    if (!writeKey) {
      throw new Error("SEGMENT_WRITE_KEY must be set");
    }
    instance = new Analytics({ writeKey, flushAt: 1 });
    log.info("segment tracker ready");
    return instance;
  };
}
