import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";
import { getDefaultStatusCallback } from "../../status-callback.js";

// agent_pay_start launches a live-call <Payments> capture session.
//
// This is the agent-assisted variant. voice_pay (TwiML <Pay> verb) is the
// one-shot IVR variant where Twilio runs the whole gather end-to-end. Here
// the LLM drives capture step by step: start → capture_card → capture_exp →
// capture_cvc → complete.
//
// statusCallback is REQUIRED by the SDK — agent_pay_start always allocates
// the connector's default webhook URL so capture-progress events route back
// through the existing onStatusCallback fan-out. Tools / procedure code
// that want to react to capture progress subscribe via the SDK directly.
// idempotencyKey is generated per call.

const OutputSchema = {
  paymentSid: z.string().describe("Payments resource SID (PKxxxx) — handle for capture/complete tools."),
  callSid: z.string().describe("Echo of the input callSid."),
  status: z.string().describe("Always 'in-progress' after a successful create — capture proceeds via update calls."),
};

export function agentPayStart(client: TwilioClient): Tool {
  return {
    name: "agent_pay_start",
    register(server) {
      server.registerTool(
        "agent_pay_start",
        {
          title: "Start Agent-Assisted Payment",
          description:
            "Begin a live-call agent-assisted payment capture against the active <Payments> API. Returns a PaymentSid the LLM uses to drive capture steps. Requires a Pay Connector configured on the Twilio account. INCURS CHARGES when chargeAmount > 0; tokenize-only when chargeAmount is omitted.",
          inputSchema: {
            callSid: z.string().describe("CallSid (CAxxxx) of the LIVE call where capture should run."),
            chargeAmount: z.number().optional().describe("Positive decimal less than 1,000,000. Omit / set to 0 to tokenize without charging."),
            currency: z.string().optional().describe("ISO-4217 currency, default 'USD'."),
            paymentConnector: z.string().optional().describe("Unique name of the Pay Connector configured in Twilio. Default 'Default'."),
            paymentMethod: z.enum(["credit-card", "ach-debit"]).optional().describe("Default 'credit-card'."),
            tokenType: z.enum(["one-time", "reusable", "payment-method"]).optional().describe("Default 'reusable'. Do not enter chargeAmount when tokenizing."),
            description: z.string().optional().describe("Description forwarded to the Pay Connector."),
            postalCode: z.boolean().optional().describe("Whether to require a postal code. Default true."),
            securityCode: z.boolean().optional().describe("Whether to require a CVC. Default true."),
            validCardTypes: z.string().optional().describe("Space-separated card types, e.g. 'visa mastercard amex'."),
            timeout: z.number().int().optional().describe("Inter-digit timeout in seconds. Default 5."),
          },
          outputSchema: OutputSchema,
        },
        async ({ callSid, chargeAmount, currency, paymentConnector, paymentMethod, tokenType, description, postalCode, securityCode, validCardTypes, timeout }) => {
          const statusCallback = await getDefaultStatusCallback();

          const opts: Record<string, unknown> = {
            idempotencyKey: randomUUID(),
            statusCallback,
          };
          if (chargeAmount !== undefined) opts.chargeAmount = chargeAmount;
          if (currency) opts.currency = currency;
          if (paymentConnector) opts.paymentConnector = paymentConnector;
          if (paymentMethod) opts.paymentMethod = paymentMethod;
          if (tokenType) opts.tokenType = tokenType;
          if (description) opts.description = description;
          if (postalCode !== undefined) opts.postalCode = postalCode;
          if (securityCode !== undefined) opts.securityCode = securityCode;
          if (validCardTypes) opts.validCardTypes = validCardTypes;
          if (timeout !== undefined) opts.timeout = timeout;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const payment = await client.calls(callSid).payments.create(opts as any);
          const data = { paymentSid: payment.sid, callSid, status: "in-progress" };
          return {
            structuredContent: data,
            content: [{ type: "text", text: `agent-pay started sid=${payment.sid} callSid=${callSid}` }],
          };
        },
      );
    },
  };
}
