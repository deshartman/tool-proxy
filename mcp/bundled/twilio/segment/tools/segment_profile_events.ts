import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SegmentProfileClient, IdType } from "../../segment-profile-client.js";

const ID_TYPES = ["phone", "email", "user_id", "anonymous_id"] as const;

const OutputSchema = {
  found: z.boolean().describe("False when Segment has no profile for this id (HTTP 404)."),
  events: z
    .array(
      z.object({
        event: z.string().describe("Event name, e.g. 'Order Completed'."),
        timestamp: z.string().describe("ISO-8601 timestamp."),
        properties: z.record(z.string(), z.unknown()).optional().describe("Event-specific properties."),
      }),
    )
    .describe("Recent events for the profile, newest first."),
  cursor: z
    .object({
      hasMore: z.boolean(),
      next: z.string().optional(),
    })
    .optional()
    .describe("Paging cursor; pass `next` back as `cursor` to fetch the next page."),
};

export function segmentProfileEvents(client: SegmentProfileClient): Tool {
  return {
    name: "segment_profile_events",
    register(server) {
      server.registerTool(
        "segment_profile_events",
        {
          description:
            "Fetches recent events for a unified profile (track calls, page views, etc). Identify the profile by any external id; page with `cursor`.",
          inputSchema: {
            id_type: z.enum(ID_TYPES).describe("External-id type used to look up the profile."),
            value: z.string().describe("Value of the external id, e.g. '+15551234567' for phone."),
            limit: z.number().int().positive().max(200).optional().describe("Max events per page (Segment caps at 200)."),
            include: z.string().optional().describe("Comma-separated list of event names to filter to."),
            cursor: z.string().optional().describe("Paging cursor from a prior response's `cursor.next`."),
          },
          outputSchema: OutputSchema,
        },
        async ({ id_type, value, limit, include, cursor }) => {
          const result = await client.getEvents(id_type as IdType, value, { limit, include, next: cursor });
          if (!result) {
            const data = { found: false, events: [] };
            return {
              structuredContent: data,
              content: [{ type: "text", text: `no profile for ${id_type}:${value}` }],
            };
          }
          const data = {
            found: true,
            events: result.events,
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
