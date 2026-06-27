import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

export const agentPayError: Prompt = {
  name: "agent_pay_error",
  register(server) {
    server.registerPrompt(
      "agent_pay_error",
      {
        description: "Recovery guidance when the upstream procedure surfaces a payment error.",
        argsSchema: {
          callSid: z.string(),
          paymentSid: z.string(),
          errorType: z.string().describe("The errorType or result value surfaced by the upstream procedure (e.g. 'invalid-card-number', 'payment-connector-error', 'timeout', 'card-declined')."),
        },
      },
      ({ callSid, paymentSid, errorType }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `A payment error occurred on callSid=${callSid}, paymentSid=${paymentSid}. Reported errorType="${errorType}".\n\n` +
                `Classify the error:\n` +
                `- Caller-side input error (invalid-card-number, invalid-expiration-date, invalid-security-code, timeout): apologise briefly, then call agent_pay_capture_card (or _exp / _cvc) again to retry that step. The same paymentSid can re-capture individual fields — do NOT restart from agent_pay_start.\n` +
                `- Connector / processor error (payment-connector-error, card-declined, insufficient-funds): explain to the caller that the payment did not go through. Do NOT retry without explicit caller direction. Offer to try a different card (which DOES require a fresh agent_pay_start) or to abandon the transaction.\n` +
                `- Session-level error (max-attempts-reached, invalid-status-callback): apologise and abandon the session. Surface the failure to whatever upstream workflow is consuming the procedure result.\n\n` +
                `In all cases: keep the caller informed. Do NOT speculate about why the error occurred or quote internal error names verbatim — translate to caller-friendly language.`,
            },
          },
        ],
      }),
    );
  },
};
