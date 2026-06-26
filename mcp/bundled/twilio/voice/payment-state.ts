// In-process state map for agent-assisted payment captures.
//
// Twilio's REST PaymentInstance is informationally bare — it carries SID +
// timestamps and nothing else. The masked PAN, card type, partial digits,
// token, and confirmation code arrive EXCLUSIVELY through the statusCallback
// webhook. So the agent_payment_status resource has to read from a local
// store populated by a status-callback listener.
//
// Lifetime: one capture session is sub-minute. We cap the Map at 200 entries
// and evict the oldest dateUpdated when adding the 201st — no setInterval,
// no TTL daemon. If 200 concurrent payments stall mid-capture, the oldest
// loses state; acceptable for v1.
//
// Wire-format: the Twilio status-callback POST body uses PascalCase keys
// (PaymentSid, CallSid, PaymentCardNumber, etc.). The connector forwards them
// verbatim through the webhook frame; the agent_payment_status resource
// surfaces them as camelCase in the JSON payload so the field shape is
// idiomatic for an LLM consumer.

import type { WebhookEvent } from "@mcp-shim/connector/sdk";

export interface PaymentState {
  callSid: string;
  paymentSid: string;
  paymentCardNumber?: string;       // masked, e.g. "411111xxxxxx1111"
  paymentCardType?: string;
  expirationDate?: string;
  securityCode?: string;
  postalCode?: string;
  paymentToken?: string;
  paymentConfirmationCode?: string;
  paymentMethod?: string;
  result?: string;
  capture?: string;
  partialResult?: string;
  errorType?: string;
  dateUpdated: string;              // set on every record; used for LRU eviction
}

const MAX_ENTRIES = 200;
const states = new Map<string, PaymentState>();

const keyOf = (callSid: string, paymentSid: string): string => `${callSid}::${paymentSid}`;

function readStringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function recordPaymentEvent(event: WebhookEvent): void {
  const body = event.body;
  const callSid = readStringField(body, "CallSid");
  const paymentSid = readStringField(body, "PaymentSid");
  if (!callSid || !paymentSid) return;

  const key = keyOf(callSid, paymentSid);
  const prior = states.get(key);
  const next: PaymentState = {
    callSid,
    paymentSid,
    paymentCardNumber:        readStringField(body, "PaymentCardNumber")        ?? prior?.paymentCardNumber,
    paymentCardType:          readStringField(body, "PaymentCardType")          ?? prior?.paymentCardType,
    expirationDate:           readStringField(body, "ExpirationDate")           ?? prior?.expirationDate,
    securityCode:             readStringField(body, "SecurityCode")             ?? prior?.securityCode,
    postalCode:               readStringField(body, "PostalCode")               ?? prior?.postalCode,
    paymentToken:             readStringField(body, "PaymentToken")             ?? prior?.paymentToken,
    paymentConfirmationCode:  readStringField(body, "PaymentConfirmationCode")  ?? prior?.paymentConfirmationCode,
    paymentMethod:            readStringField(body, "PaymentMethod")            ?? prior?.paymentMethod,
    result:                   readStringField(body, "Result")                   ?? prior?.result,
    capture:                  readStringField(body, "Capture")                  ?? prior?.capture,
    partialResult:            readStringField(body, "PartialResult")            ?? prior?.partialResult,
    errorType:                readStringField(body, "ErrorType")                ?? prior?.errorType,
    dateUpdated: new Date(event.receivedAt).toISOString(),
  };

  if (!states.has(key) && states.size >= MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestStamp = Infinity;
    for (const [k, v] of states) {
      const t = Date.parse(v.dateUpdated);
      if (t < oldestStamp) { oldestStamp = t; oldestKey = k; }
    }
    if (oldestKey) states.delete(oldestKey);
  }

  states.set(key, next);
}

export function getPaymentState(callSid: string, paymentSid: string): PaymentState | undefined {
  return states.get(keyOf(callSid, paymentSid));
}

// Exposed for tests; not part of the runtime path.
export function __resetForTests(): void {
  states.clear();
}
