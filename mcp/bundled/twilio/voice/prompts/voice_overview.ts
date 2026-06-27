import type { Prompt } from "@mcp-shim/connector/sdk";

export const voiceOverview: Prompt = {
  name: "voice_overview",
  register(server) {
    server.registerPrompt(
      "voice_overview",
      {
        description: "Quick reference for which Twilio voice tool to call (call control, TwiML composition, real-time transcription, the two distinct payment-capture paths).",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Twilio voice — tool selection guide.\n\n` +
                `PLACE a call: calls_create. Pass either inline twiml (a TwiML XML string) or url (a webhook that returns TwiML). INCURS CHARGES. ` +
                `LOOK UP a call after placing it: calls_fetch with the SID; returns status, direction, duration, and timing.\n\n` +
                `COMPOSE TwiML inline (no separate webhook): use voice_say (text-to-speech), voice_play (audio file URL or DTMF tones), voice_dial (bridge to another party). ` +
                `Each returns a TwiML fragment you can concatenate and pass to calls_create's twiml arg.\n\n` +
                `REAL-TIME TRANSCRIPTION on a live call: voice_transcription_start to begin streaming words to a Conversation Intelligence service; voice_transcription_stop to end. Useful for compliance, summarization, real-time intent detection.\n\n` +
                `PAYMENTS — two distinct paths, pick by use case:\n` +
                `  • voice_pay — emits the TwiML <Pay> verb. Twilio runs the entire gather flow IVR-style; the LLM never sees intermediate digits. Use for unattended one-shot capture.\n` +
                `  • agent_pay_start + agent_pay_capture_* + agent_pay_complete — uses the live-call <Payments> API. The LLM drives each capture step (card → expiration → CVC), reads masked state via status callbacks, narrates back to the caller. Use when an agent (human or LLM) is on the line. Fetch the agent_pay_start_capture prompt for the full live-call walkthrough.\n\n` +
                `PREREQUISITE for agent_pay_*: the Twilio account needs a configured Pay Connector (Stripe, Braintree, etc.). voice_pay also needs this. Without one, both paths return an error from the Twilio API.`,
            },
          },
        ],
      }),
    );
  },
};
