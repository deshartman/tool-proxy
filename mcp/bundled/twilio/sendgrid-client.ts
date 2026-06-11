import sgClient from "@sendgrid/client";
import { createLogger } from "@mcp-shim/connector/sdk";

// Single SendGrid client shared across email_* tools. Boot fails fast on
// missing creds so the server never half-starts (mirrors twilio-client.ts).
//
// Auth: SENDGRID_API_KEY (single API key, prefix `SG.`).
let ready = false;
const log = createLogger("sendgrid-mcp");

export function getSendGridClient(): typeof sgClient {
  if (ready) return sgClient;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    throw new Error("SENDGRID_API_KEY must be set");
  }
  sgClient.setApiKey(key);
  ready = true;
  log.info("sendgrid client ready");
  return sgClient;
}
