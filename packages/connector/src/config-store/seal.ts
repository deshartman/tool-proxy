import { createRequire } from "node:module";
import type SodiumType from "libsodium-wrappers";

// libsodium-wrappers@0.7.15 ships a broken ESM entry: its
// dist/modules-esm/libsodium-wrappers.mjs imports a sibling `./libsodium.mjs`
// that doesn't exist in that folder (the real file lives in the peer
// `libsodium` package). Bypass by loading the CJS build via createRequire,
// which walks node_modules as CJS does and resolves libsodium correctly.
// This matches the sanctioned CJS-under-ESM pattern used elsewhere in the
// connector (see TSX_BIN in mcp-supervisor.ts).
const requireCjs = createRequire(import.meta.url);
const sodium = requireCjs("libsodium-wrappers") as typeof SodiumType;

// One-time init before any seal/open call. The connector calls this once at boot.
export async function initSodium(): Promise<void> {
  await sodium.ready;
}

// Layout: [24-byte nonce][ciphertext]
export function seal(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES));
  const ct = Buffer.from(sodium.crypto_secretbox_easy(plaintext, nonce, key));
  return Buffer.concat([nonce, ct]);
}

export function open(sealed: Buffer, key: Buffer): Buffer {
  const nonce = sealed.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
  const ct = sealed.subarray(sodium.crypto_secretbox_NONCEBYTES);
  const pt = sodium.crypto_secretbox_open_easy(ct, nonce, key);
  if (!pt) throw new Error("seal-open failed: authentication tag mismatch (tampered ciphertext or wrong key).");
  return Buffer.from(pt);
}
