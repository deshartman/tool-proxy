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
  return { reason: reasonOf(error), url };
}

// Pick the most useful one-line description of a dial failure.
//
// Plain Error with a real .message → use .message (regression-pinned: covers
// "Tunnel rejected with status 502", "Tunnel dial timed out …", etc.).
//
// AggregateError from Node's happy-eyeballs dial (IPv4+IPv6 concurrent
// connect) has an EMPTY top-level .message and carries per-family sub-errors
// with matching syscall .code. For that case, surface .code plus the first
// sub-error's address:port so the operator sees "ECONNREFUSED 127.0.0.1:3001"
// instead of "".
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    const code = readCode(error);
    if (code) {
      const addr = firstAddrPort(error);
      return addr ? `${code} ${addr}` : code;
    }
    return error.name || "Error";
  }
  return String(error);
}

function readCode(err: object): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function firstAddrPort(error: Error): string | undefined {
  const errs = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errs)) return undefined;
  for (const inner of errs) {
    if (inner === null || typeof inner !== "object") continue;
    const address = (inner as { address?: unknown }).address;
    const port = (inner as { port?: unknown }).port;
    if (typeof address === "string" && typeof port === "number") {
      return `${address}:${port}`;
    }
  }
  return undefined;
}
