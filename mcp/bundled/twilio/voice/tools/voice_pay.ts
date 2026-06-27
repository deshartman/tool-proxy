import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

// PromptFor enum from the Twilio TwiML SDK. Each value drives a specific
// step in <Pay>'s gather flow (card number, expiration, CVC, postal code, etc.).
const promptFor = z.enum([
  "payment-card-number",
  "expiration-date",
  "security-code",
  "postal-code",
  "bank-routing-number",
  "bank-account-number",
  "payment-processing",
]);

const promptItem = z.object({
  for: promptFor.describe("Which payment data element this prompt is for."),
  text: z
    .string()
    .optional()
    .describe("Spoken text shown via a nested <Say>. Optional — Twilio uses defaults when omitted."),
});

const parameterItem = z.object({
  name: z.string().describe("Custom parameter name forwarded to your payment connector."),
  value: z.string().describe("Custom parameter value."),
});

const OutputSchema = {
  twiml: z.string().describe("Complete <Response> TwiML XML."),
};

export function voicePay(): Tool {
  return {
    name: "voice_pay",
    register(server) {
      server.registerTool(
        "voice_pay",
        {
          description:
            "Build a TwiML document that securely captures a credit card or ACH payment via PCI-compliant <Pay>. Returns a complete <Response>. CHARGES the card if chargeAmount > 0.",
          inputSchema: {
            chargeAmount: z
              .string()
              .optional()
              .describe(
                "Amount to charge (e.g. '10.00'). Set to '0' or omit to tokenize the card without charging.",
              ),
            currency: z.string().optional().describe("ISO-4217 currency, e.g. 'USD'."),
            paymentConnector: z
              .string()
              .optional()
              .describe("Unique name of the payment connector configured in the Twilio console."),
            paymentMethod: z
              .enum(["credit-card", "ach-debit"])
              .optional()
              .describe("Defaults to credit-card."),
            description: z.string().optional().describe("Description sent to the connector."),
            action: z.string().optional().describe("Webhook URL invoked when the gather completes."),
            maxAttempts: z.number().int().min(1).optional().describe("Maximum retry count."),
            prompts: z.array(promptItem).optional().describe("Custom prompts per gather step."),
            parameters: z
              .array(parameterItem)
              .optional()
              .describe("Custom name/value parameters forwarded to the payment connector."),
          },
          outputSchema: OutputSchema,
        },
        async ({ chargeAmount, currency, paymentConnector, paymentMethod, description, action, maxAttempts, prompts, parameters }) => {
          const response = new VoiceResponse();
          const attrs: Record<string, unknown> = {};
          if (chargeAmount !== undefined) attrs.chargeAmount = chargeAmount;
          if (currency) attrs.currency = currency;
          if (paymentConnector) attrs.paymentConnector = paymentConnector;
          if (paymentMethod) attrs.paymentMethod = paymentMethod;
          if (description) attrs.description = description;
          if (action) attrs.action = action;
          if (maxAttempts !== undefined) attrs.maxAttempts = maxAttempts;
          const pay = response.pay(attrs);

          for (const promptSpec of prompts ?? []) {
            const prompt = pay.prompt({ for: promptSpec.for });
            if (promptSpec.text) prompt.say(promptSpec.text);
          }
          for (const param of parameters ?? []) {
            pay.parameter({ name: param.name, value: param.value });
          }

          const xml = response.toString();
          return {
            structuredContent: { twiml: xml },
            content: [{ type: "text", text: xml }],
          };
        },
      );
    },
  };
}
