import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayStartCapture: Prompt = {
  name: "agent_pay_start_capture",
  register(server) {
    server.registerPrompt(
      "agent_pay_start_capture",
      {
        description: "Opening instructions for the LLM to introduce an agent-assisted payment capture to the caller and launch the <Payments> session.",
        argsSchema: {
          callSid: z.string().describe("CallSid (CAxxxx) of the live call."),
        },
      },
      ({ callSid }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `You are about to begin an agent-assisted payment capture on call ${callSid}.\n\n` +
                `1. Briefly tell the caller you'll collect their payment details securely, and that they'll enter digits on their keypad (DTMF). Their card number will be masked in your view.\n` +
                `2. Call agent_pay_start with callSid="${callSid}", an appropriate chargeAmount (or omit for tokenize-only), and any required paymentConnector / paymentMethod options.\n` +
                `3. The tool returns a paymentSid. Hold onto it — every subsequent step needs both callSid and paymentSid.\n` +
                `4. Proceed to agent_pay_capture_card. Use the agent_pay_card_number prompt for what to say during that step.\n\n` +
                `Throughout the flow, read payment://${callSid}/<paymentSid>/status (the agent_payment_status resource) between steps to see what Twilio has captured so far. Never narrate full digits — only echo what the resource shows (masked).`,
            },
          },
        ],
      }),
    );
  },
};
