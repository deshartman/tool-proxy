import sgClient from "@sendgrid/client";
import { createLogger } from "@mcp-shim/connector/sdk";

// Lazy SendGrid client provider. Returns a thunk so tools can ask for the
// configured client when they actually fire — operators who don't use any
// email_* tools don't need SENDGRID_API_KEY set just to boot. Mirrors the
// prior getSendGridClient() singleton's lazy contract; the migration to
// DI factories elsewhere stays eager (Twilio is required by every voice/
// messaging/verify/lookups tool, so eager validation is fine), but
// SendGrid is opt-in.
//
// Auth: SENDGRID_API_KEY (single API key, prefix `SG.`).

export type SendGridClient = typeof sgClient;
export type SendGridClientProvider = () => SendGridClient;

const log = createLogger("sendgrid-mcp");

export function makeSendGridProvider(env: NodeJS.ProcessEnv = process.env): SendGridClientProvider {
  let ready = false;
  return () => {
    if (ready) return sgClient;
    const key = env.SENDGRID_API_KEY;
    if (!key) {
      throw new Error("SENDGRID_API_KEY must be set");
    }
    sgClient.setApiKey(key);
    ready = true;
    log.info("sendgrid client ready");
    return sgClient;
  };
}
