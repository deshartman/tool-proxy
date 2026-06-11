import twilio from "twilio";
import { createLogger } from "@mcp-shim/connector/sdk";

// Single Twilio client shared across tools. Boot fails fast on missing creds
// so the server never half-starts.
//
// Auth modes (selected by env-var presence; ApiKey is preferred for production):
//   1. ApiKey:    TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
//   2. AuthToken: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
let client: ReturnType<typeof twilio> | undefined;
const log = createLogger("twilio-mcp");

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (client) return client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

  if (!sid) {
    throw new Error("TWILIO_ACCOUNT_SID must be set");
  }

  if (apiKeySid && apiKeySecret) {
    client = twilio(apiKeySid, apiKeySecret, { accountSid: sid });
    log.info({ auth: "apikey" }, "twilio client ready");
  } else if (authToken) {
    client = twilio(sid, authToken);
    log.info({ auth: "authtoken" }, "twilio client ready");
  } else {
    throw new Error(
      "Twilio auth missing: set TWILIO_AUTH_TOKEN, OR TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET",
    );
  }
  return client;
}
