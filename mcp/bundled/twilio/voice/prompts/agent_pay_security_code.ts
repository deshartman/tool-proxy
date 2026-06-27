import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPaySecurityCode: Prompt = {
  name: "agent_pay_security_code",
  register(server) {
    server.registerPrompt(
      "agent_pay_security_code",
      {
        description: "Guidance during security-code (CVC) capture.",
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
                `agent_pay_capture_cvc has been called for callSid=${callSid}, paymentSid=${paymentSid}. Twilio is asking the caller for the CVC (3 or 4 digits).\n\n` +
                `- Stay off the line while they enter digits.\n` +
                `- If the caller seems uncertain about the CVC location, you can briefly explain: "It's the 3-digit code on the back of most cards, or the 4-digit code on the front for American Express."\n\n` +
                `Once capture finishes, proceed to the agent_pay_finish prompt — the caller confirms before you submit. Do NOT call agent_pay_complete until the caller has explicitly confirmed.`,
            },
          },
        ],
      }),
    );
  },
};
