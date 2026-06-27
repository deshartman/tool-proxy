import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

const OutputSchema = {
  paymentSid: z.string().describe("Echo of input paymentSid."),
  capture: z.string().describe("Always 'security-code' after a successful call."),
};

export function agentPayCaptureCvc(client: TwilioClient): Tool {
  return {
    name: "agent_pay_capture_cvc",
    register(server) {
      server.registerTool(
        "agent_pay_capture_cvc",
        {
          description:
            "Advance the agent-assisted payment session into CVC / security-code capture. Caller enters the 3-4 digit code; poll agent_payment_status to see the masked value.",
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
            capture: "security-code",
          });
          const data = { paymentSid, capture: "security-code" };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `capturing security-code sid=${paymentSid}` }],
          };
        },
      );
    },
  };
}
