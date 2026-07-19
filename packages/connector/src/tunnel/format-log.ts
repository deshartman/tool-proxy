// Log payload builder for recoverable tunnel handshake failures.
//
// The whole point of this helper is what it does NOT do: it does not put
// the Error object under a field named `err`. Pino intercepts any field
// literally named `err` and runs it through stdSerializers.err, which
// inlines the full stack trace. For expected transient failures (WS 502
// during a controller restart, ngrok cycling, dial timeout, ECONNREFUSED,
// DNS blip) the stack is noise — the very next log line schedules an
// auto-reconnect, and the operator only needs the message + the URL that
// was being dialed.
//
// Non-recoverable failures (post-open WS errors, register-ack rejection)
// intentionally do NOT go through this helper — they still log through
// pino's `err`-field path with the full stack.
//
// Regression pinned in tests/tunnel/format-log.test.ts — specifically the
// "does not include a pino `err` field" assertion. Do not rename that
// field name check away without understanding pino's serializer contract.
export function formatHandshakeFailure(
  error: unknown,
  url: string
): { reason: string; url: string } {
  const reason = error instanceof Error ? error.message : String(error);
  return { reason, url };
}
