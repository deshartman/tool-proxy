import type { Prompt } from "@mcp-shim/connector/sdk";

export const segmentOverview: Prompt = {
  name: "segment_overview",
  register(server) {
    server.registerPrompt(
      "segment_overview",
      {
        description: "Quick reference for Segment Profile (read) + Tracking (write) flows — when to use each tool and which creds gate which.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Segment — tool selection guide.\n\n` +
                `Two independent flows; the controller can supply credentials for one or both:\n\n` +
                `READ — Profile API (requires SEGMENT_SPACE_ID + SEGMENT_PROFILE_PAT):\n` +
                `  • segment_profile_traits({ id_type, value }) — latest unified traits for a user.\n` +
                `  • segment_profile_events({ id_type, value, limit?, next? }) — recent events on the profile, paginated.\n` +
                `  • segment_profile_external_ids({ id_type, value }) — every external id (email, phone, userId, anonymousId) linked to the profile.\n` +
                `  id_type is one of "email", "phone", "user_id", "anonymous_id". Use whichever identifier you have.\n\n` +
                `WRITE — Tracking API (requires SEGMENT_WRITE_KEY):\n` +
                `  • segment_identify({ userId | anonymousId, traits? }) — upsert traits onto a profile.\n` +
                `  • segment_track({ userId | anonymousId, event, properties? }) — record an event ("Order Completed", "Form Submitted", etc.).\n` +
                `  Prefer userId when known; fall back to anonymousId for pre-auth interactions. Segment links anonymous→user identities when you later send an identify with both.\n\n` +
                `If only one set of creds is present, the unavailable tools won't be in tools/list — check there before assuming a tool exists.\n\n` +
                `For EU-resident Segment workspaces, the controller sets SEGMENT_PROFILE_HOST to https://profiles.euw1.segment.com; default is the US endpoint.`,
            },
          },
        ],
      }),
    );
  },
};
