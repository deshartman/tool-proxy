import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { SegmentProfileClient, IdType } from "../../segment-profile-client.js";

const ID_TYPES = ["phone", "email", "user_id", "anonymous_id"] as const;

const OutputSchema = {
  found: z.boolean().describe("False when Segment has no profile for this id (HTTP 404)."),
  externalIds: z
    .array(
      z.object({
        type: z.string().describe("Id type, e.g. 'phone' / 'email' / 'user_id' / customer-defined."),
        id: z.string().describe("Id value."),
        source_id: z.string().optional().describe("Segment source id that wrote this external id."),
        collection: z.string().optional().describe("Collection name (defaults to 'users')."),
        created_at: z.string().optional().describe("ISO-8601 timestamp."),
        encoding: z.string().optional().describe("Encoding (e.g. 'none', 'sha256')."),
      }),
    )
    .describe("All external ids linked to this profile — useful for cross-channel reconciliation (find a user's email given their phone, etc)."),
};

export function segmentProfileExternalIds(client: SegmentProfileClient): Tool {
  return {
    name: "segment_profile_external_ids",
    register(server) {
      server.registerTool(
        "segment_profile_external_ids",
        {
          description:
            "Lists every external id linked to a unified profile (phone, email, user_id, anonymous_id, plus any customer-defined collection ids). Identify the profile by any one external id and discover the rest.",
          inputSchema: {
            id_type: z.enum(ID_TYPES).describe("External-id type used to look up the profile."),
            value: z.string().describe("Value of the external id, e.g. '+15551234567' for phone."),
          },
          outputSchema: OutputSchema,
        },
        async ({ id_type, value }) => {
          const result = await client.getExternalIds(id_type as IdType, value);
          if (!result) {
            const data = { found: false, externalIds: [] };
            return {
              structuredContent: data,
              content: [{ type: "text", text: `no profile for ${id_type}:${value}` }],
            };
          }
          const data = { found: true, externalIds: result.externalIds };
          return {
            structuredContent: data,
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      );
    },
  };
}
