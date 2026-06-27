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
                `agent_pay_capture_exp has been called for callSid=${callSid}, paymentSid=${paymentSid}. Twilio is asking the caller for the expiration date (MMYY, four digits).\n\n` +
                `- Stay off the line while they enter digits.\n` +
                `- If the caller asks for help, you can clarify: "Four digits — two for the month, two for the year."\n` +
                `- If they enter the wrong value, call agent_pay_capture_exp again to retry.\n\n` +
                `Proceed to agent_pay_capture_cvc once capture finishes. Use the agent_pay_security_code prompt next.`,
            },
          },
        ],
      }),
    );
  },
};
