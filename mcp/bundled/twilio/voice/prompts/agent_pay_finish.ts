import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayFinish: Prompt = {
  name: "agent_pay_finish",
  register(server) {
    server.registerPrompt(
      "agent_pay_finish",
      {
        description: "Read-back step: confirm the captured details with the caller before submitting to the Pay Connector.",
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
                `All three capture steps are complete for callSid=${callSid}, paymentSid=${paymentSid}.\n\n` +
                `Before finalizing:\n` +
                `1. Read payment://${callSid}/${paymentSid}/status one more time.\n` +
                `2. Read back to the caller: the masked card number (paymentCardNumber), the card type (paymentCardType), and the expiration date (expirationDate). Do NOT read back the security code.\n` +
                `3. Ask the caller: "Should I submit this payment?" — wait for explicit confirmation (yes / submit / proceed).\n` +
                `4. On confirmation, call agent_pay_complete with callSid and paymentSid.\n` +
                `5. If they say no or want to change a field, restart the corresponding agent_pay_capture_* step.\n\n` +
                `Do NOT call agent_pay_complete without verbal confirmation.`,
            },
          },
        ],
      }),
    );
  },
};
