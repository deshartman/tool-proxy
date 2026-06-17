// Generic statusCallback helper for the Twilio MCP.
//
// Many Twilio APIs accept a `statusCallback` URL that Twilio POSTs delivery
// or status updates to (Messages, Calls, Recordings, Pay, Conversations,
// Verify, Fax, Video — the list keeps growing). Today an MCP author has
// to either (a) hardcode a public URL, (b) ask the operator to run an
// ngrok tunnel, or (c) skip status callbacks entirely.
//
// This helper sits on top of the connector's createWebhookEndpoint SDK and
// gives every Twilio tool one shared statusCallback URL. Allocation is lazy
// (first caller wins) and the URL is reused for the lifetime of the MCP
// child process. The connector handles the controller-side mint, persists
// the URL across reconnects, and forwards inbound POSTs as `webhook` frames.
//
// Usage from a tool:
//
//   import { getDefaultStatusCallback, onStatusCallback } from "../../status-callback.js";
//   const url = await getDefaultStatusCallback();
//   onStatusCallback((event) => log.info({ params: event.queryParameters, body: event.body }, "status"));
//   await client.messages.create({ to, body, statusCallback: url });
//
// Notes:
// - URL is shared across tools by design. Twilio's own MessageSid / CallSid
//   in the body lets the receiver fan-out to the right correlation.
// - The helper does not await delivery before returning — the upstream
//   API responds with a 201 the moment the message/call is queued; the
//   statusCallback POST(s) come later, asynchronously.
// - If the connector was started with --no-inspector, INSPECTOR_PORT=0,
//   getDefaultStatusCallback() throws — webhook ingress is unavailable
//   without the inspector loopback.

import { createWebhookEndpoint, createLogger, type WebhookEndpoint, type WebhookEvent } from "@mcp-shim/connector/sdk";

const log = createLogger("twilio-status-callback");

// The MCP server name matches `name:` in connector.yaml's mcp_servers entry
// for this folder. Today that's "apis" (see mcp/bundled/twilio/server.ts).
// Keeping it as a constant so every callsite gets the same name without
// hard-coding it scattered across tool files.
const MCP_NAME = "apis";

let endpointPromise: Promise<WebhookEndpoint> | undefined;
const listeners = new Set<(event: WebhookEvent) => void>();

function getEndpoint(): Promise<WebhookEndpoint> {
  if (endpointPromise !== undefined) return endpointPromise;
  endpointPromise = allocate();
  return endpointPromise;
}

async function allocate(): Promise<WebhookEndpoint> {
  try {
    const endpoint = await createWebhookEndpoint({ mcp: MCP_NAME });
    // One subscription, fanned out to every onStatusCallback caller. Saves
    // round-tripping every listener through a separate SSE stream.
    endpoint.on("callback", (event: WebhookEvent) => {
      for (const fn of listeners) {
        try { fn(event); }
        catch (e) { log.error({ err: e as Error }, "status-callback listener threw"); }
      }
    });
    endpoint.on("url", (url: string) => log.info({ url }, "status-callback URL refreshed"));
    endpoint.on("error", (err: Error) => log.error({ err }, "status-callback endpoint error"));
    log.info({ url: endpoint.url }, "status-callback endpoint allocated");
    return endpoint;
  } catch (e) {
    log.error({ err: e as Error }, "status-callback allocation failed");
    // Reset so the next caller gets a fresh attempt — useful when the
    // connector boots later than the MCP for some reason. Crucially, the
    // reset only fires when allocation itself failed: a downstream caller
    // throwing after `await getEndpoint()` no longer wipes the cached
    // endpoint, which the previous .then().catch() shape did.
    endpointPromise = undefined;
    throw e;
  }
}

// Returns the public URL Twilio should POST to. Allocates lazily on the first
// call and reuses the same URL for the lifetime of the MCP child process.
export async function getDefaultStatusCallback(): Promise<string> {
  const endpoint = await getEndpoint();
  return endpoint.url;
}

// Register a listener for any inbound statusCallback. Returns an unsubscribe
// function. Listeners receive every status callback that arrives — they
// should filter by MessageSid / CallSid / etc. as appropriate.
export function onStatusCallback(listener: (event: WebhookEvent) => void): () => void {
  listeners.add(listener);
  // Trigger allocation in the background so the URL is ready when the first
  // tool call asks for it. Best-effort — failures are logged inside.
  void getEndpoint().catch(() => { /* logged in getEndpoint */ });
  return () => listeners.delete(listener);
}

// ───────────────────────────────────────────────────────────────────────
// waitForStatus — per-SID awaitable
//
// Tool authors call this after kicking off an async Twilio operation:
//
//   const msg = await client.messages.create({ to, body, statusCallback: url });
//   const finalStatus = await waitForStatus(msg.sid, {
//     timeout: 30_000,
//     until: (s) => s === "delivered" || s === "failed",
//   });
//
// Twilio embeds the correlation key as one of:
//   MessageSid, CallSid, RecordingSid, ConferenceSid, FaxSid, RoomSid …
// We sniff the body and the queryParameters for any of these and match on the
// first that equals `sid`. Status (the value passed to `until`) is sniffed in
// the same way: MessageStatus / CallStatus / RecordingStatus / etc.

export interface WaitForStatusOptions {
  // Maximum time to wait for a matching event. On expiry, the promise rejects
  // with a TimeoutError-like Error containing `code: 'timeout'`. No default —
  // pass an explicit number; an MCP that waits forever will leak listeners
  // when the upstream API never delivers a callback.
  timeout: number;
  // Predicate over the status string (e.g. "delivered", "failed", "ringing").
  // Returning true resolves the promise with that status. If omitted, the
  // FIRST callback for the given SID resolves.
  until?: (status: string) => boolean;
}

const SID_KEYS = ["MessageSid", "CallSid", "RecordingSid", "ConferenceSid", "FaxSid", "RoomSid"] as const;
const STATUS_KEYS = ["MessageStatus", "CallStatus", "RecordingStatus", "ConferenceStatus", "FaxStatus", "RoomStatus"] as const;

function readField(payload: unknown, keys: readonly string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return undefined;
}

// Pull the SID embedded in either the form-decoded body or the query params.
export function extractSid(event: WebhookEvent): string | undefined {
  return readField(event.body, SID_KEYS) ?? readField(event.queryParameters, SID_KEYS);
}

// Pull the status string from either the form-decoded body or the query params.
export function extractStatus(event: WebhookEvent): string | undefined {
  return readField(event.body, STATUS_KEYS) ?? readField(event.queryParameters, STATUS_KEYS);
}

// TODO(user): implement waitForStatus — see "How to apply" below.
//
// Constraints / things to think about:
// - Multiple awaiters may exist for the same SID concurrently (two tool calls
//   to different APIs, both happen to await delivery). They should all see
//   the same events.
// - When the predicate `until` is provided, only events whose extracted
//   status satisfies it should resolve. Events that don't satisfy `until`
//   should be ignored, NOT cause rejection.
// - When `until` is omitted, the first event for that SID resolves with
//   whatever status was in it (may be undefined if the upstream didn't
//   include one — in that case resolve with the empty string or design
//   another way to signal "callback received, no status field").
// - Always clean up: remove the listener on resolve, reject, or timeout.
// - Use the existing `onStatusCallback(listener)` API to register your
//   internal listener — don't reach into `listeners` directly. Keeping
//   this layered means a future change to onStatusCallback's signature
//   doesn't break waitForStatus.
//
// Suggested signature:
//   export function waitForStatus(sid: string, opts: WaitForStatusOptions): Promise<string>
export function waitForStatus(sid: string, opts: WaitForStatusOptions): Promise<string> {
  void sid; void opts;
  return Promise.reject(new Error("waitForStatus not yet implemented — see status-callback.ts TODO"));
}
