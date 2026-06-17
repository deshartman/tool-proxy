import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

const numberItem = z.object({
  number: z.string().describe("E.164 destination, e.g. +15551234567"),
  sendDigits: z
    .string()
    .optional()
    .describe("DTMF tones to play once the call is answered, e.g. 'wwww1234#'."),
  statusCallback: z.string().optional().describe("Webhook URL for per-leg status."),
});

const sipItem = z.object({
  uri: z.string().describe("SIP URI, e.g. sip:alice@example.com"),
  username: z.string().optional(),
  password: z.string().optional(),
});

const clientItem = z.object({
  identity: z.string().describe("Client identity registered against your TwiML app."),
});

export function voiceDial(): Tool {
  return {
    name: "voice_dial",
    register(server) {
      server.registerTool(
        "voice_dial",
        {
          description:
            "Build a TwiML document that bridges the call to one or more endpoints (PSTN numbers, SIP URIs, Twilio Clients). Children render in order: numbers → sips → clients. Returns a complete <Response>.",
          inputSchema: {
            callerId: z
              .string()
              .optional()
              .describe("Caller-ID shown to the dialed party. Defaults to the inbound caller's number."),
            timeout: z.number().int().min(1).optional().describe("Seconds to wait for answer."),
            record: z
              .enum(["do-not-record", "record-from-answer", "record-from-ringing", "record-from-answer-dual", "record-from-ringing-dual"])
              .optional()
              .describe("Recording mode for the dialed call."),
            answerOnBridge: z
              .boolean()
              .optional()
              .describe("Preserve ringing on the inbound leg until the dialed party answers."),
            action: z
              .string()
              .optional()
              .describe("Webhook URL invoked when the dialed call ends, with DialCallStatus."),
            numbers: z.array(numberItem).optional().describe("PSTN destinations as <Number> children."),
            sips: z.array(sipItem).optional().describe("SIP destinations as <Sip> children."),
            clients: z.array(clientItem).optional().describe("Twilio Client destinations as <Client> children."),
          },
        },
        async ({ callerId, timeout, record, answerOnBridge, action, numbers, sips, clients }) => {
          if (!numbers?.length && !sips?.length && !clients?.length) {
            throw new Error("Provide at least one of numbers, sips, or clients");
          }
          const response = new VoiceResponse();
          const dialAttrs: Record<string, unknown> = {};
          if (callerId) dialAttrs.callerId = callerId;
          if (timeout !== undefined) dialAttrs.timeout = timeout;
          if (record) dialAttrs.record = record;
          if (answerOnBridge !== undefined) dialAttrs.answerOnBridge = answerOnBridge;
          if (action) dialAttrs.action = action;
          const dial = response.dial(dialAttrs);

          for (const number of numbers ?? []) {
            const attrs: Record<string, unknown> = {};
            if (number.sendDigits) attrs.sendDigits = number.sendDigits;
            if (number.statusCallback) attrs.statusCallback = number.statusCallback;
            dial.number(attrs, number.number);
          }
          for (const sip of sips ?? []) {
            const attrs: Record<string, unknown> = {};
            if (sip.username) attrs.username = sip.username;
            if (sip.password) attrs.password = sip.password;
            dial.sip(attrs, sip.uri);
          }
          for (const client of clients ?? []) {
            dial.client(client.identity);
          }

          return {
            content: [{ type: "text", text: response.toString() }],
          };
        },
      );
    },
  };
}
