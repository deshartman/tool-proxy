import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import type { TwilioClient } from "../../twilio-client.js";

// Content template summary — variables/types are SDK-shaped JSON we don't
// flatten further (a template can carry several types: text, media, etc.).
const OutputSchema = {
  sid: z.string().describe("Content template SID (HXxxxx)."),
  friendlyName: z.string().nullable().describe("Operator-facing template name."),
  language: z.string().nullable().describe("BCP-47 language tag."),
  variables: z.unknown().describe("Placeholder map; SDK-shaped."),
  types: z.unknown().describe("Type-keyed configurations (text/media/etc.)."),
};

export function contentTemplatesFetch(client: TwilioClient): Tool {
  return {
    name: "content_templates_fetch",
    register(server) {
      server.registerTool(
        "content_templates_fetch",
        {
          description: "Fetches a Content template (HXxxxx) by SID and returns its variables, types, and friendly name. Use the SID with messages_create.contentSid for templated WhatsApp/RCS sends.",
          inputSchema: {
            sid: z.string().describe("Content template SID, e.g. HXxxxxxxxx"),
          },
          outputSchema: OutputSchema,
        },
        async ({ sid }) => {
          const content = await client.content.v1.contents(sid).fetch();
          const summary = {
            sid: content.sid,
            friendlyName: content.friendlyName,
            language: content.language,
            variables: content.variables,
            types: content.types,
          };
          return {
            structuredContent: summary,
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          };
        },
      );
    },
  };
}
