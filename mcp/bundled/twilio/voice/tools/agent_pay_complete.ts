import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

// agent_pay_complete finalizes the capture. Twilio sends the captured
// payment information to the configured Pay Connector for processing
// (tokenize-only or charge, depending on what agent_pay_start was launched
// with). The final result — paymentToken, paymentConfirmationCode, result
// — arrives via the statusCallback and lands in the local state Map.
// Poll agent_payment_status until result is populated.

const OutputSchema = {
  paymentSid: z.string().describe("Echo of input paymentSid."),
  status: z.string().describe("Always 'complete' after a successful call. Inspect agent_payment_status for token/confirmation/error."),
};

export function agentPayComplete(client: TwilioClient): Tool {
  return {
    name: "agent_pay_complete",
    register(server) {
      server.registerTool(
        "agent_pay_complete",
        {
          title: "Complete Agent Payment",
          description:
            "Finalize the agent-assisted payment session. Twilio sends captured fields to the Pay Connector; the final token / confirmation code / error lands in agent_payment_status via the statusCallback. INCURS CHARGES when agent_pay_start was launched with a non-zero chargeAmount.",
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
            status: "complete",
          });
          const data = { paymentSid, status: "complete" };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `agent-pay complete requested sid=${paymentSid}` }],
          };
        },
      );
    },
  };
}
