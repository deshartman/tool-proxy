import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayCompletion: Prompt = {
  name: "agent_pay_completion",
  register(server) {
    server.registerPrompt(
      "agent_pay_completion",
      {
        description: "Closing instructions after agent_pay_complete: confirm success to the caller.",
        argsSchema: {
          callSid: z.string(),
          paymentSid: z.string(),
        },
      },
      ({ callSid, paymentSid }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `agent_pay_complete has been called for callSid=${callSid}, paymentSid=${paymentSid}. Twilio is now submitting the captured payment to the Pay Connector.\n\n` +
                `- On success, acknowledge to the caller (e.g. "Your payment has been processed successfully."). If the controller-side procedure carries a confirmation number from your upstream system, read that back.\n` +
                `- If the connector returns a failure, switch to the agent_pay_error prompt to handle the failure conversationally.\n` +
                `- Never read back the full card number, the token, or the security code under any circumstance.\n\n` +
                `Once acknowledged, the capture flow is complete. Continue with whatever post-payment workflow the procedure defines (logging, follow-up confirmation, etc.).`,
            },
          },
        ],
      }),
    );
  },
};
