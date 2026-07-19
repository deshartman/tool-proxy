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
