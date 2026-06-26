import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayCompletion: Prompt = {
  name: "agent_pay_completion",
  register(server) {
    server.registerPrompt(
      "agent_pay_completion",
      {
        description: "Closing instructions after agent_pay_complete returns: confirm success to the caller and surface the token/confirmation code.",
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
                `agent_pay_complete has been called for callSid=${callSid}, paymentSid=${paymentSid}.\n\n` +
                `Poll payment://${callSid}/${paymentSid}/status until result is populated:\n` +
                `- If result === "success": acknowledge to the caller (e.g. "Your payment has been processed successfully."). If paymentConfirmationCode is present, read it back. If paymentToken is present (tokenize-only mode), do NOT read it back — store it via whatever upstream system the procedure dictates.\n` +
                `- If result indicates a failure (e.g. "payment-connector-error", "card-declined"): switch to the agent_pay_error prompt to handle the failure conversationally.\n\n` +
                `Once acknowledged, the capture flow is complete. You can continue with whatever post-payment workflow the procedure defines (logging, follow-up confirmation, etc.).`,
            },
          },
        ],
      }),
    );
  },
};
