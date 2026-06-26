import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Resource } from "@mcp-shim/connector/sdk";
import { getPaymentState } from "../payment-state.js";

// agent_payment_status — read-only surface over the live <Payments> capture
// state, keyed by (callSid, paymentSid). State is populated by the status
// callback listener installed in agent_pay_start; reads return whatever has
// arrived so far. Empty state (no callback yet) returns an all-nulls payload
// so the LLM can poll without distinguishing 'wrong SID' from 'in-flight'.

export const agentPaymentStatus: Resource = {
  name: "agent_payment_status",
  register(server) {
    server.registerResource(
      "agent_payment_status",
      new ResourceTemplate(
        "payment://{callSid}/{paymentSid}/status",
        { list: undefined },
      ),
      {
        title: "Agent-assisted payment status",
        description: "Live capture state for an agent-assisted <Payments> session. Returns masked PAN, captured fields, token, and confirmation code as the status callback delivers them.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const callSid = String(variables.callSid);
        const paymentSid = String(variables.paymentSid);
        const state = getPaymentState(callSid, paymentSid);
        const payload = state ?? {
          callSid,
          paymentSid,
          paymentCardNumber: null,
          paymentCardType: null,
          expirationDate: null,
          securityCode: null,
          postalCode: null,
          paymentToken: null,
          paymentConfirmationCode: null,
          paymentMethod: null,
          result: null,
          capture: null,
          partialResult: null,
          errorType: null,
          dateUpdated: null,
        };
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          }],
        };
      },
    );
  },
};
