// The proxy's own identity (MULTI-PLATFORM-MCP §3.1, decisions D1 + D8).
//
// Distinct from everything that looks like it: the platform-minted
// `connectorId` (one per platform, returned in register-ack), each
// controllers[] entry's `id` (one per tunnel), and `keyFingerprint` (derived
// from the master key, so it changes on rotation). The proxy id is minted once
// per install and names this proxy in every tool name it sends, on every
// platform it connects to.
//
// Format: 8 characters of lowercase Crockford base32, from 40 random bits.
//   * lowercase only, so it survives case-insensitive handling;
//   * Crockford drops i l o u, so a human reading it aloud can't confuse them;
//   * every character is in OpenAI's tool-name alphabet [a-zA-Z0-9_-].
// 40 bits is about a 1-in-10⁶ birthday collision at 1,500 proxies in one org;
// the platform's per-org duplicate guard turns the residue into a refusal.
//
// Not secret: it appears in every tool name.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH = 8;
const PROXY_ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

export function mintProxyId(): string {
  // 5 bytes = 40 bits = exactly 8 base32 digits, so no bits are wasted or biased.
  let value = 0n;
  for (const byte of randomBytes(5)) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function isProxyId(value: unknown): value is string {
  return typeof value === "string" && PROXY_ID_RE.test(value);
}
