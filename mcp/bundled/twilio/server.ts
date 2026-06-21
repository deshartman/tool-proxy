import { createMcpHttpServer, createLogger, type Tool } from "@mcp-shim/connector/sdk";
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
  const obj = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
const pickSid    = (payload: unknown) => pickFirst(payload, ["MessageSid", "CallSid"]);
const pickStatus = (payload: unknown) => pickFirst(payload, ["MessageStatus", "CallStatus"]);

// Creds gating — split by service so each group registers independently.
//
// Under MCP-LOADING, the bundle has no `.env` file. Every credential
// arrives over the WS via creds-response (boot) or creds-update (operator
// edit), and the supervisor restarts this child whenever the merged env
// changes — see docs/MCP-PROTOCOL.md.
//
// Twilio tools (messaging / voice / verify / lookups, 16 total) require
// TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. SendGrid tools (email_*, 4 total)
// require SENDGRID_API_KEY. Customers running only one of the two services
// see only that group's tools; the other stays absent. Within a group it's
// all-or-nothing — supplying TWILIO_ACCOUNT_SID without TWILIO_AUTH_TOKEN
// (or vice versa) registers zero Twilio tools.
//
// envKeys is declared at the server level so the connector's creds-request
// advertises every key the controller might fill in, even when no tools
// have registered yet. The controller pushes whichever group's creds the
// operator has configured; missing keys for the other group are simply
// absent in creds-response.env (NOT empty strings — see MCP-PROTOCOL.md
// §"Twilio-bundled auto-fill" rules).
const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const SENDGRID_KEYS = ["SENDGRID_API_KEY"] as const;
const allEnvKeys = [...TWILIO_KEYS, ...SENDGRID_KEYS];

const twilioMissing = TWILIO_KEYS.filter((key) => !process.env[key]);
const sendgridMissing = SENDGRID_KEYS.filter((key) => !process.env[key]);

const tools: Tool[] = [];

if (twilioMissing.length === 0) {
  const twilio = createTwilioClient();
  tools.push(
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
  );
} else {
  log.warn(
    { missing: twilioMissing, required: [...TWILIO_KEYS] },
    "twilio tools deferred — awaiting creds-update",
  );
}

if (sendgridMissing.length === 0) {
  const sendgridProvider = makeSendGridProvider();
  tools.push(
    emailSend(sendgridProvider),
    emailFetch(sendgridProvider),
    emailSearch(sendgridProvider),
    emailTemplatesFetch(sendgridProvider),
  );
} else {
  log.warn(
    { missing: sendgridMissing, required: [...SENDGRID_KEYS] },
    "sendgrid tools deferred — awaiting creds-update",
  );
}

await createMcpHttpServer({
  name: "apis",
  tools,
  envKeys: allEnvKeys,
});
