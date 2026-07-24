import { createHash, randomUUID } from "node:crypto";

// Deterministic externalId derivation. Same (channel, normalisedValue) →
// same externalId across process restarts. Useful for demos where the
// connector bounces and we want the same customer to keep the same ID.
//
// 12 hex chars = 48 bits. Collision-safe for a mock with modest state.
// Real providers should use UUIDv4/v7 tied to their storage.
export function externalIdFor(channel: string, normalisedValue: string): string {
  const hash = createHash("sha1");
  hash.update(`${channel}::${normalisedValue}`);
  return hash.digest("hex").slice(0, 12);
}

// Episode IDs are per-append, not per-identity — random UUIDs keep them
// unique even when the same episode text is appended twice.
export function episodeId(): string {
  return randomUUID();
}
