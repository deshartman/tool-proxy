import twilio from "twilio";

// Single Twilio client shared across tools. Boot fails fast on missing creds
// so the server never half-starts.
let client: ReturnType<typeof twilio> | undefined;

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (client) return client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  client = twilio(sid, token);
  return client;
}
