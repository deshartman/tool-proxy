import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

const OutputSchema = {
  paymentSid: z.string().describe("Echo of input paymentSid."),
  capture: z.string().describe("Always 'expiration-date' after a successful call."),
};

export function agentPayCaptureExp(client: TwilioClient): Tool {
  return {
    name: "agent_pay_capture_exp",
    register(server) {
      server.registerTool(
        "agent_pay_capture_exp",
        {
          title: "Capture Expiration Date",
          description:
            "Advance the agent-assisted payment session into expiration-date capture. Caller enters MMYY digits; poll agent_payment_status for the captured value.",
          inputSchema: {
            callSid: z.string().describe("CallSid of the live call."),
            paymentSid: z.string().describe("PaymentSid from agent_pay_start."),
          },
          outputSchema: OutputSchema,
        },
        async ({ callSid, paymentSid }) => {
          const statusCallback = await getDefaultStatusCallback();
          await client.calls(callSid).payments(paymentSid).update({
            idempotencyKey: randomUUID(),
            statusCallback,
            capture: "expiration-date",
          });
          const data = { paymentSid, capture: "expiration-date" };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `capturing expiration-date sid=${paymentSid}` }],
          };
        },
      );
    },
  };
}
