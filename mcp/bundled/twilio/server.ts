import { createMcpHttpServer, createLogger } from "@mcp-shim/connector/sdk";
import { onStatusCallback } from "./status-callback.js";
import { createTwilioClient } from "./twilio-client.js";
import { makeSendGridProvider } from "./sendgrid-client.js";
import { messagesCreate } from "./tools/messaging/messages_create.js";
import { messagesFetch } from "./tools/messaging/messages_fetch.js";
import { messagingServicesFetch } from "./tools/messaging/messaging_services_fetch.js";
import { contentTemplatesFetch } from "./tools/messaging/content_templates_fetch.js";
import { callsCreate } from "./tools/voice/calls_create.js";
import { callsFetch } from "./tools/voice/calls_fetch.js";
import { voiceSay } from "./tools/voice/voice_say.js";
import { voicePlay } from "./tools/voice/voice_play.js";
import { voiceDial } from "./tools/voice/voice_dial.js";
import { voicePay } from "./tools/voice/voice_pay.js";
import { voiceTranscriptionStart } from "./tools/voice/voice_transcription_start.js";
import { voiceTranscriptionStop } from "./tools/voice/voice_transcription_stop.js";
import { verifySend } from "./tools/verify/verify_send.js";
import { verifyCheck } from "./tools/verify/verify_check.js";
import { verifyServicesFetch } from "./tools/verify/verify_services_fetch.js";
import { lookupsFetch } from "./tools/lookups/lookups_fetch.js";
import { emailSend } from "./tools/email/email_send.js";
import { emailFetch } from "./tools/email/email_fetch.js";
import { emailSearch } from "./tools/email/email_search.js";
import { emailTemplatesFetch } from "./tools/email/email_templates_fetch.js";

// Default observer for inbound Twilio statusCallback POSTs. Logs every event
// — individual tools (or future enrichment code) can layer their own
// onStatusCallback listeners on top to react to delivery state changes.
const log = createLogger("apis");
onStatusCallback((event) => {
  const sid = pickSid(event.body) ?? pickSid(event.queryParameters);
  log.info(
    { sid, status: pickStatus(event.body) ?? pickStatus(event.queryParameters), receivedAt: event.receivedAt },
    "statusCallback received",
  );
});

function pickFirst(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, unknown>;
  for (const k of keys) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}
const pickSid    = (p: unknown) => pickFirst(p, ["MessageSid", "CallSid"]);
const pickStatus = (p: unknown) => pickFirst(p, ["MessageStatus", "CallStatus"]);

// Build clients at boot. Twilio is eager-validated (every voice/messaging/
// verify/lookups tool needs it; failing fast surfaces missing creds before
// the first tool call). SendGrid is a lazy provider — operators who never
// fire an email_* tool don't need SENDGRID_API_KEY just to boot. Matches
// the prior singleton's lazy contract.
const twilio = createTwilioClient();
const sendgridProvider = makeSendGridProvider();

await createMcpHttpServer({
  name: "apis",
  tools: [
    messagesCreate(twilio),
    messagesFetch(twilio),
    messagingServicesFetch(twilio),
    contentTemplatesFetch(twilio),
    callsCreate(twilio),
    callsFetch(twilio),
    voiceSay(),
    voicePlay(),
    voiceDial(),
    voicePay(),
    voiceTranscriptionStart(),
    voiceTranscriptionStop(),
    verifySend(twilio),
    verifyCheck(twilio),
    verifyServicesFetch(twilio),
    lookupsFetch(twilio),
    emailSend(sendgridProvider),
    emailFetch(sendgridProvider),
    emailSearch(sendgridProvider),
    emailTemplatesFetch(sendgridProvider),
  ],
});
