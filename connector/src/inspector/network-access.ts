// CONNECTOR-NETWORK-EXPOSURE — loopback detection used by the server.ts
// request gate. There is no admin session concept: the operator UI stays
// loopback-only unconditionally, forever. Only the machine API (POST
// /oauth/token and future JWT-protected routes) is ever reachable from a
// non-loopback caller, and only once an operator has added the first API
// client (see network-access-routes.ts's handleAddClient).

export function isLoopbackAddr(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // Node reports IPv4 loopback as ::ffff:127.0.0.1 when the server is
  // listening on an IPv6 socket with dual-stack enabled.
  const addr = remoteAddress.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}
