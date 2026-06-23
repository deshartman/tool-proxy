import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SegmentProfileClient, IdType } from "../../segment-profile-client.js";

const ID_TYPES = ["phone", "email", "user_id", "anonymous_id"] as const;

const OutputSchema = {
  found: z.boolean().describe("False when Segment has no profile for this id (HTTP 404)."),
  traits: z.record(z.string(), z.unknown()).nullable().describe("Latest value per trait. Customer-defined keys; values are scalars or nested objects."),
  cursor: z
    .object({
      hasMore: z.boolean(),
      next: z.string().optional(),
    })
    .optional()
    .describe("Paging cursor; pass `next` back as `cursor` to fetch the next page."),
};

export function segmentProfileTraits(client: SegmentProfileClient): Tool {
  return {
    name: "segment_profile_traits",
    register(server) {
      server.registerTool(
        "segment_profile_traits",
        {
          description:
            "Fetches the latest value of every trait Segment knows about a unified profile. Identify the profile by any external id (phone, email, user_id, anonymous_id).",
          inputSchema: {
            id_type: z.enum(ID_TYPES).describe("External-id type used to look up the profile."),
            value: z.string().describe("Value of the external id, e.g. '+15551234567' for phone."),
            limit: z.number().int().positive().max(200).optional().describe("Max number of traits to return (Segment caps at 200)."),
            include: z.string().optional().describe("Comma-separated list of trait names to filter to."),
            cursor: z.string().optional().describe("Paging cursor from a prior response's `cursor.next`."),
          },
          outputSchema: OutputSchema,
        },
        async ({ id_type, value, limit, include, cursor }) => {
          const result = await client.getTraits(id_type as IdType, value, { limit, include, next: cursor });
          if (!result) {
            const data = { found: false, traits: null };
            return {
              structuredContent: data,
              content: [{ type: "text", text: `no profile for ${id_type}:${value}` }],
            };
          }
          const data = {
            found: true,
            traits: result.traits,
            cursor: result.cursor ? { hasMore: result.cursor.has_more, next: result.cursor.next } : undefined,
          };
          return {
            structuredContent: data,
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      );
    },
  };
}
