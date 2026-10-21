import { z } from "zod";
import type { Prompt } from "@gtmi/toolproxy-connector/sdk";

// Refund-flow guidance: force the model to look up the order via get_recent
// before firing issue_refund, and to confirm the amount aloud with the
// caller. issue_refund's `orderId` is not something a caller will
// remember — the model has to derive it from get_recent's response.
// Escalation criteria are intentionally left qualitative so the calling
// procedure can tune the specific thresholds without editing this prompt.
export const handleRefundRequest: Prompt = {
  name: "handle_refund_request",
  register(server) {
    server.registerPrompt(
      "handle_refund_request",
      {
        description:
          "Guides the model through processing a refund: identify the order, gather the reason, issue the refund, and escalate if needed.",
        argsSchema: {
          callerPhone: z
            .string()
            .describe("Caller's E.164 phone (drives the get_recent lookup)."),
        },
      },
      ({ callerPhone }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `The caller at ${callerPhone} is requesting a refund. Do NOT ask them for an order id — look it up.`,
                "",
                "Sequence:",
                `  1. Call get_recent({ phone: "${callerPhone}" }) and identify which order the refund refers to. If there are multiple candidate orders, read them back and ask the caller which one.`,
                "  2. Ask the caller for the refund reason in their own words — this becomes the `reason` field on the tool call.",
                "  3. Confirm the amount aloud with the caller before firing the tool. The number must come from them agreeing to what you propose, not from you guessing.",
                "  4. Call issue_refund({ orderId, amount, currency, reason }). Only override `currency` from the USD default if the order's own currency differs.",
                "",
                "Escalate via notify_agent when:",
                "  - The refund is significantly larger than a typical order for this customer (compare against get_recent's history).",
                "  - The caller sounds distressed or references a prior complaint.",
                "  - issue_refund returns an error you can't self-resolve after one retry.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  },
};

export default handleRefundRequest;
