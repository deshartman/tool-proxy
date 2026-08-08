// CONNECTOR-NETWORK-EXPOSURE — admin-session primitives shared by the
// server.ts request gate and network-access-routes.ts's login/enable/rotate
// handlers.
//
// Two independent notions of "trusted" live here:
//   1. Loopback — always trusted, forever, regardless of network-access
//      state (the permanent recovery path). isLoopbackAddr() below.
//   2. A minted admin session — an opaque bearer token handed out after a
//      successful POST /internal/network-access/login. Sessions are
//      in-memory only (Map, not Postgres): a process restart requires the
//      admin to log in again, same as a browser session cookie would.

import type { IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function isLoopbackAddr(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // Node reports IPv4 loopback as ::ffff:127.0.0.1 when the server is
  // listening on an IPv6 socket with dual-stack enabled.
  const addr = remoteAddress.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

// Opaque bearer tokens minted on successful login. No expiry — bounded by
// process lifetime, same as the tokens issued would need re-issuing after a
// restart. Verify is constant-time per-candidate so an attacker can't learn
// which stored token is closest via response timing.
export class AdminSessionStore {
  private readonly tokens = new Set<string>();

  mint(): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.add(token);
    return token;
  }

  verify(candidate: string | undefined): boolean {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    const supplied = Buffer.from(candidate, "utf8");
    for (const known of this.tokens) {
      const knownBuf = Buffer.from(known, "utf8");
      if (knownBuf.length !== supplied.length) continue;
      if (timingSafeEqual(knownBuf, supplied)) return true;
    }
    return false;
  }
}

// Reads the session bearer from `Authorization: Bearer <token>`, falling
// back to a `?token=` query parameter ONLY for /events — EventSource can't
// set custom headers, so that's the one route the token travels as a query
// param instead. Every other route requires the header.
export function extractSessionToken(req: IncomingMessage, path: string, query: URLSearchParams): string | undefined {
  const header = req.headers["authorization"];
  const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  const match = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  if (match?.[1]) return match[1].trim();
  if (path === "/events") {
    const fromQuery = query.get("token");
    if (fromQuery) return fromQuery;
  }
  return undefined;
}
