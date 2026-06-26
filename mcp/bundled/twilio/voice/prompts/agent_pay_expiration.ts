import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayExpiration: Prompt = {
  name: "agent_pay_expiration",
  register(server) {
    server.registerPrompt(
      "agent_pay_expiration",
      {
        description: "Guidance during expiration-date capture.",
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
                `agent_pay_capture_exp has been called for callSid=${callSid}, paymentSid=${paymentSid}. Twilio is asking the caller for the expiration date (MMYY).\n\n` +
                `- Stay off the line while they enter digits.\n` +
                `- Poll payment://${callSid}/${paymentSid}/status until expirationDate populates with the four-digit value.\n` +
                `- If errorType appears (e.g. "invalid-card-number" carried over, or "timeout") restart the relevant capture step.\n\n` +
                `Once expirationDate is set, proceed to agent_pay_capture_cvc. Use the agent_pay_security_code prompt next.`,
            },
          },
        ],
      }),
    );
  },
};
