import { createMcpHttpServer, createLogger, type Tool, type Prompt } from "@mcp-shim/connector/sdk";
import { onStatusCallback } from "./status-callback.js";
import { createTwilioClient } from "./twilio-client.js";
import { makeSendGridProvider } from "./sendgrid-client.js";
// Messaging
import { messagesCreate } from "./messaging/tools/messages_create.js";
import { messagesFetch } from "./messaging/tools/messages_fetch.js";
import { messagingServicesFetch } from "./messaging/tools/messaging_services_fetch.js";
import { contentTemplatesFetch } from "./messaging/tools/content_templates_fetch.js";
import { messagingOverview } from "./messaging/prompts/messaging_overview.js";
// Voice
import { callsCreate } from "./voice/tools/calls_create.js";
import { callsFetch } from "./voice/tools/calls_fetch.js";
import { voiceSay } from "./voice/tools/voice_say.js";
import { voicePlay } from "./voice/tools/voice_play.js";
import { voiceDial } from "./voice/tools/voice_dial.js";
import { voicePay } from "./voice/tools/voice_pay.js";
import { voiceTranscriptionStart } from "./voice/tools/voice_transcription_start.js";
import { voiceTranscriptionStop } from "./voice/tools/voice_transcription_stop.js";
import { agentPayStart } from "./voice/tools/agent_pay_start.js";
import { agentPayCaptureCard } from "./voice/tools/agent_pay_capture_card.js";
import { agentPayCaptureExp } from "./voice/tools/agent_pay_capture_exp.js";
import { agentPayCaptureCvc } from "./voice/tools/agent_pay_capture_cvc.js";
import { agentPayComplete } from "./voice/tools/agent_pay_complete.js";
import { agentPayStartCapture } from "./voice/prompts/agent_pay_start_capture.js";
import { agentPayCardNumber } from "./voice/prompts/agent_pay_card_number.js";
import { agentPayExpiration } from "./voice/prompts/agent_pay_expiration.js";
import { agentPaySecurityCode } from "./voice/prompts/agent_pay_security_code.js";
import { agentPayFinish } from "./voice/prompts/agent_pay_finish.js";
import { agentPayCompletion } from "./voice/prompts/agent_pay_completion.js";
import { agentPayError } from "./voice/prompts/agent_pay_error.js";
import { voiceOverview } from "./voice/prompts/voice_overview.js";
// Verify
import { verifySend } from "./verify/tools/verify_send.js";
import { verifyCheck } from "./verify/tools/verify_check.js";
import { verifyServicesFetch } from "./verify/tools/verify_services_fetch.js";
import { verifyOverview } from "./verify/prompts/verify_overview.js";
// Lookups
import { lookupsFetch } from "./lookups/tools/lookups_fetch.js";
import { lookupsOverview } from "./lookups/prompts/lookups_overview.js";
// Email
import { emailSend } from "./email/tools/email_send.js";
import { emailFetch } from "./email/tools/email_fetch.js";
import { emailSearch } from "./email/tools/email_search.js";
import { emailTemplatesFetch } from "./email/tools/email_templates_fetch.js";
import { emailOverview } from "./email/prompts/email_overview.js";
// Segment
import { createSegmentProfileClient } from "./segment-profile-client.js";
import { makeSegmentTracker } from "./segment-tracker.js";
import { segmentProfileTraits } from "./segment/tools/segment_profile_traits.js";
import { segmentProfileEvents } from "./segment/tools/segment_profile_events.js";
import { segmentProfileExternalIds } from "./segment/tools/segment_profile_external_ids.js";
import { segmentIdentify } from "./segment/tools/segment_identify.js";
import { segmentTrack } from "./segment/tools/segment_track.js";
import { segmentOverview } from "./segment/prompts/segment_overview.js";

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
const SEGMENT_READ_KEYS = ["SEGMENT_SPACE_ID", "SEGMENT_PROFILE_PAT"] as const;
const SEGMENT_WRITE_KEYS = ["SEGMENT_WRITE_KEY"] as const;
const allEnvKeys = [
  ...TWILIO_KEYS,
  ...SENDGRID_KEYS,
  ...SEGMENT_READ_KEYS,
  ...SEGMENT_WRITE_KEYS,
];

const twilioMissing = TWILIO_KEYS.filter((key) => !process.env[key]);
const sendgridMissing = SENDGRID_KEYS.filter((key) => !process.env[key]);
const segmentReadMissing = SEGMENT_READ_KEYS.filter((key) => !process.env[key]);
const segmentWriteMissing = SEGMENT_WRITE_KEYS.filter((key) => !process.env[key]);

const tools: Tool[] = [];
const prompts: Prompt[] = [];

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
    agentPayStart(twilio),
    agentPayCaptureCard(twilio),
    agentPayCaptureExp(twilio),
    agentPayCaptureCvc(twilio),
    agentPayComplete(twilio),
    verifySend(twilio),
    verifyCheck(twilio),
    verifyServicesFetch(twilio),
    lookupsFetch(twilio),
  );
  prompts.push(
    messagingOverview,
    voiceOverview,
    verifyOverview,
    lookupsOverview,
    agentPayStartCapture,
    agentPayCardNumber,
    agentPayExpiration,
    agentPaySecurityCode,
    agentPayFinish,
    agentPayCompletion,
    agentPayError,
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
  prompts.push(emailOverview);
} else {
  log.warn(
    { missing: sendgridMissing, required: [...SENDGRID_KEYS] },
    "sendgrid tools deferred — awaiting creds-update",
  );
}

if (segmentReadMissing.length === 0) {
  const profile = createSegmentProfileClient();
  tools.push(
    segmentProfileTraits(profile),
    segmentProfileEvents(profile),
    segmentProfileExternalIds(profile),
  );
} else {
  log.warn(
    { missing: segmentReadMissing, required: [...SEGMENT_READ_KEYS] },
    "segment read tools deferred — awaiting creds-update",
  );
}

if (segmentWriteMissing.length === 0) {
  const tracker = makeSegmentTracker();
  tools.push(segmentIdentify(tracker), segmentTrack(tracker));
} else {
  log.warn(
    { missing: segmentWriteMissing, required: [...SEGMENT_WRITE_KEYS] },
    "segment write tools deferred — awaiting creds-update",
  );
}

// Segment overview prompt: surfaces if EITHER read or write creds are
// present. The prompt itself explains which flows the LLM can use given
// the current creds — one prompt covers both directions.
if (segmentReadMissing.length === 0 || segmentWriteMissing.length === 0) {
  prompts.push(segmentOverview);
}

await createMcpHttpServer({
  name: "apis",
  tools,
  prompts,
  envKeys: allEnvKeys,
});
