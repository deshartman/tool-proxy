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

// Creds gating — all-or-nothing.
//
// Under MCP-LOADING, the bundle has no `.env` file. Every credential
// arrives over the WS via creds-response (boot) or creds-update (operator
// edit), and the supervisor restarts this child whenever the merged env
// changes — see docs/MCP-PROTOCOL.md.
//
// Until ALL three keys are present we register zero tools and let the
// connector advertise an empty `apis` MCP. When the keys land, the
// supervisor restarts this process; the next boot registers all 20 tools
// and the connector pushes a manifest-delta to the controller.
//
// envKeys is declared at the server level (not per-tool) so the
// connector's creds-request advertises the required keys to the controller
// even when no tool has registered yet. Without that, an empty MCP would
// also have an empty envKeys list — the controller would not know what to
// fill in from its tunnel-security row.
const requiredEnvKeys = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY"] as const;
const missing = requiredEnvKeys.filter((key) => !process.env[key]);

let tools: Tool[] = [];
if (missing.length === 0) {
  const twilio = createTwilioClient();
  const sendgridProvider = makeSendGridProvider();
  tools = [
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
  ];
} else {
  log.warn(
    { missing, required: [...requiredEnvKeys] },
    "deferred — awaiting creds-update",
  );
}

await createMcpHttpServer({
  name: "apis",
  tools,
  envKeys: [...requiredEnvKeys],
});
