import twilio from "twilio";
import { createLogger } from "@mcp-shim/connector/sdk";

// Build a Twilio client from explicit env. Replaces the prior
// getTwilioClient() singleton with a factory so tools take the client as
// a parameter instead of reaching into module state — easier to reason
// about (no boot-order coupling) and easier to test (each call gets its
// own instance from its own env map).
//
// Throws when TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is unset. The throw
// is a defensive backstop — server.ts gates registration on env presence
// before calling this factory (see §"Conditional tool registration" in
// docs/MCP-PROTOCOL.md), so the throw only fires if a future caller
// bypasses that gate.
//
// Auth: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. API Key/Secret was removed
// to keep the bundle's auth shape aligned with the controller's
// creds-response auto-fill (see docs/MCP-PROTOCOL.md "Twilio-bundled
// auto-fill"). Customers who want revocable per-service credentials should
// mint a scoped subaccount AuthToken rather than an API Key.

export type TwilioClient = ReturnType<typeof twilio>;

const log = createLogger("twilio-mcp");

export function createTwilioClient(env: NodeJS.ProcessEnv = process.env): TwilioClient {
  const sid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!sid) {
    throw new Error("TWILIO_ACCOUNT_SID must be set");
  }
  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN must be set");
  }
  log.info({ auth: "authtoken" }, "twilio client ready");
  return twilio(sid, authToken);
}
