import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayCardNumber: Prompt = {
  name: "agent_pay_card_number",
  register(server) {
    server.registerPrompt(
      "agent_pay_card_number",
      {
        description: "Guidance during card-number capture: what to say to the caller while DTMF digits arrive on the masked PAN.",
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
                `- Periodically read payment://${callSid}/${paymentSid}/status to confirm digits are arriving. The paymentCardNumber field updates with the masked PAN (e.g. "411111xxxxxx1111").\n` +
                `- If paymentCardNumber stays empty or the resource shows errorType after 30+ seconds, ask the caller if they're having trouble and offer to restart capture.\n\n` +
                `When the resource shows a full masked PAN AND paymentCardType (visa / mastercard / amex / discover), proceed to agent_pay_capture_exp. Use the agent_pay_expiration prompt next.`,
            },
          },
        ],
      }),
    );
  },
};
