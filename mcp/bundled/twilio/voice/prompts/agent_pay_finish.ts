import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayFinish: Prompt = {
  name: "agent_pay_finish",
  register(server) {
    server.registerPrompt(
      "agent_pay_finish",
      {
        description: "Read-back step: confirm with the caller before submitting to the Pay Connector.",
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
                `All three capture steps have run for callSid=${callSid}, paymentSid=${paymentSid}.\n\n` +
                `Before finalizing:\n` +
                `1. Ask the caller: "I'm about to submit your payment for processing. Should I go ahead?" — wait for explicit confirmation (yes / submit / proceed).\n` +
                `2. On confirmation, call agent_pay_complete with callSid and paymentSid.\n` +
                `3. If they say no or want to change a field, restart the corresponding agent_pay_capture_* step.\n\n` +
                `Do NOT call agent_pay_complete without verbal confirmation.`,
            },
          },
        ],
      }),
    );
  },
};
