// Shared bounded JSON-body reader for inspector routes.
//
// The inspector binds to 127.0.0.1 only, so this is defense-in-depth for
// shared-container localhost (a sibling MCP could otherwise flood a POST
// route) and for operator-pasted-a-giant-blob accidents — not a remote-
// attacker DoS. 64 KiB matches the operator-facing paste ceiling of the
// session-creds routes; any legitimate inspector POST is well under this.
//
// Handlers should catch and branch on BodyTooLargeError → HTTP 413 vs
// default → HTTP 400 "malformed body" so operators get an accurate
// recovery signal (trim the payload vs fix the JSON).
import type { IncomingMessage } from "node:http";

export const MAX_INSPECTOR_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_INSPECTOR_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_INSPECTOR_BODY_BYTES) {
      // Don't destroy the socket here — the caller needs the write side to
      // send the 413 response. Once the caller res.end()s with
      // "Connection: close" the socket is torn down cleanly; a bare
      // req.destroy() from inside the helper races the response and shows up
      // on the client as ECONNRESET instead of a 413.
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
