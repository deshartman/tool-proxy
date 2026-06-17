import twilio from "twilio";
import { createLogger } from "@mcp-shim/connector/sdk";

// Build a Twilio client from explicit env. Replaces the prior
// getTwilioClient() singleton with a factory so tools take the client as
// a parameter instead of reaching into module state — easier to reason
// about (no boot-order coupling) and easier to test (each call gets its
// own instance from its own env map).
//
// Auth modes (selected by env-var presence; ApiKey is preferred for
// production):
//   1. ApiKey:    TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
//   2. AuthToken: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN

export type TwilioClient = ReturnType<typeof twilio>;

const log = createLogger("twilio-mcp");

export function createTwilioClient(env: NodeJS.ProcessEnv = process.env): TwilioClient {
  const sid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const apiKeySid = env.TWILIO_API_KEY_SID;
  const apiKeySecret = env.TWILIO_API_KEY_SECRET;

  if (!sid) {
    throw new Error("TWILIO_ACCOUNT_SID must be set");
  }

  if (apiKeySid && apiKeySecret) {
    log.info({ auth: "apikey" }, "twilio client ready");
    return twilio(apiKeySid, apiKeySecret, { accountSid: sid });
  }
  if (authToken) {
    log.info({ auth: "authtoken" }, "twilio client ready");
    return twilio(sid, authToken);
  }
  throw new Error(
    "Twilio auth missing: set TWILIO_AUTH_TOKEN, OR TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET",
  );
}
