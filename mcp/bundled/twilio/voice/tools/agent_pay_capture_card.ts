import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

// agent_pay_capture_card advances the live-call <Payments> session into
// card-number capture. Twilio prompts the caller for digits via the call
// audio; each digit triggers a status-callback POST that updates the local
// state Map. The LLM reads agent_payment_status to see digits arriving.
//
// idempotencyKey is regenerated per call — Twilio requires it.

const OutputSchema = {
  paymentSid: z.string().describe("Echo of input paymentSid."),
  capture: z.string().describe("Always 'payment-card-number' after a successful call."),
};

export function agentPayCaptureCard(client: TwilioClient): Tool {
  return {
    name: "agent_pay_capture_card",
    register(server) {
      server.registerTool(
        "agent_pay_capture_card",
        {
          title: "Capture Card Number",
          description:
            "Advance the agent-assisted payment session into card-number capture. Twilio plays a prompt to the caller and collects digits. Poll agent_payment_status (resource) to see the masked PAN populate.",
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
            capture: "payment-card-number",
          });
          const data = { paymentSid, capture: "payment-card-number" };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `capturing payment-card-number sid=${paymentSid}` }],
          };
        },
      );
    },
  };
}
