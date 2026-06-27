import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayCardNumber: Prompt = {
  name: "agent_pay_card_number",
  register(server) {
    server.registerPrompt(
      "agent_pay_card_number",
      {
        description: "Guidance during card-number capture: what to say to the caller while DTMF digits arrive.",
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
                `agent_pay_capture_card has been called for callSid=${callSid}, paymentSid=${paymentSid}. Twilio is now prompting the caller for their card number on the keypad.\n\n` +
                `While they enter digits:\n` +
                `- Stay quiet on the line. Twilio handles the keypad prompts; speaking over them can confuse the caller.\n` +
                `- Wait for capture to complete. Twilio drives the prompt; you'll know capture finished when the next step (agent_pay_capture_exp) returns successfully.\n` +
                `- If the caller verbally says they're stuck or made a mistake, offer to call agent_pay_capture_card again to restart this step.\n\n` +
                `Proceed to agent_pay_capture_exp once you're confident the caller has finished entering digits. Use the agent_pay_expiration prompt next.`,
            },
          },
        ],
      }),
    );
  },
};
