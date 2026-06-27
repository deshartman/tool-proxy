import type { Prompt } from "@mcp-shim/connector/sdk";

export const verifyOverview: Prompt = {
  name: "verify_overview",
  register(server) {
    server.registerPrompt(
      "verify_overview",
      {
        description: "Quick reference for the Twilio Verify OTP send + check flow and how to inspect a Verify Service's config.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Twilio Verify — tool selection guide.\n\n` +
                `Verify is a managed OTP service. Twilio generates, delivers, retries, and validates the code; you never see the code value itself.\n\n` +
                `STEP 1 — send: verify_send({ to, channel, serviceSid }). Twilio mints a code, delivers it via the channel ("sms" or "call"), and starts a verification attempt. INCURS CHARGES on send.\n\n` +
                `STEP 2 — check: verify_check({ to, code, serviceSid }) once the user types the code back to you. Twilio validates it and returns status — "approved" on success, "pending" or another value on mismatch. Check is FREE.\n\n` +
                `Both calls need the same Verify Service SID (VAxxxx). To inspect a service's code length, channel settings, and lookup config before using it: verify_services_fetch({ sid }). Read-only.\n\n` +
                `If the user fails verification multiple times, do NOT retry indefinitely — Twilio's per-service rate limits will start rejecting attempts. Escalate to a human agent or a different channel after 2-3 failures.`,
            },
          },
        ],
      }),
    );
  },
};
