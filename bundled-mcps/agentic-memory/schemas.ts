import { z } from "zod";

// Shared zod fragments per MEMORY-MCP-INTERFACE.md §4-§5. Kept in one file
// so the same channel + reference shapes reuse across tool files.

export const CHANNEL_VALUES = [
  "voice",
  "sms",
  "rcs",
  "mms",
  "whatsapp",
  "webchat",
  "email",
  "chat",
  "test-harness",
] as const;

export const ChannelSchema = z.enum(CHANNEL_VALUES).describe("Channel kind per MEMORY-MCP-INTERFACE.md §4.1.");

export const HydrationReferenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["procedure", "tool", "hydration"]),
  role: z.enum(["hydration", "action"]).optional(),
  target: z.string().optional(),
});

export const AliasEntrySchema = z.object({
  channel: ChannelSchema,
  value: z.string(),
  addedAt: z.string(),
});

export const EpisodeSchema = z.object({
  id: z.string(),
  summary: z.string(),
  channelKind: ChannelSchema,
  sessionKey: z.string(),
  occurredAt: z.string(),
  procedureId: z.string().optional(),
  score: z.number().min(0).max(1),
});

export const ISO_DATETIME = z.string().describe("ISO-8601 timestamp.");

// MCP-AUDIT #4 — externalId is used directly as a KEY into the state maps
// (identities / episodes / semanticCache), so an unconstrained z.string() let
// JavaScript's own prototype machinery through. Verified empirically:
//
//   identities["__proto__"]            -> Object.prototype, which is TRUTHY, so
//                                         the identity_not_found guard passed
//   identity.mergedInto                -> undefined, so the merged guard passed
//   episodes["__proto__"] ?? []        -> Object.prototype, not an array
//   list.push(...)                     -> TypeError (opaque crash, not a clean error)
//   semanticCache["__proto__"] = {...} -> REPLACED that map's prototype
//
// Constraining the input is the primary fix; emptyState/loadState additionally
// build the maps with Object.create(null) as belt-and-braces. This pattern matters
// beyond the mock: a model-supplied string used as a storage key is exactly what
// docs/KNOWLEDGE-MCP-INTERFACE.md invites customers to implement.
//
// The shape is what externalIdFor() actually emits: sha1 truncated to 12 hex
// chars. Do NOT relax this to z.string() — apply it to any field that reaches a
// state map as a key (that includes identity-merge's winner/loser). It must NOT be
// applied to OUTPUT schemas: identity_resolve and identity_lookup produce the id.
export const EXTERNAL_ID_RE = /^[0-9a-f]{12}$/;

export const ExternalIdSchema = z
  .string()
  .regex(EXTERNAL_ID_RE, "externalId must be 12 lowercase hex characters (as returned by identity_resolve)")
  .describe("Identity handle from identity_resolve — 12 lowercase hex chars.");
