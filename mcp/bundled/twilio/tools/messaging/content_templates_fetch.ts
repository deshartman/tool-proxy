import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { getTwilioClient } from "../../twilio-client.js";

export const contentTemplatesFetch: Tool = {
  name: "content_templates_fetch",
  register(server) {
    server.registerTool(
      "content_templates_fetch",
      {
        description: "Fetches a Content template (HXxxxx) by SID and returns its variables, types, and friendly name. Use the SID with messages_create.contentSid for templated WhatsApp/RCS sends.",
        inputSchema: {
          sid: z.string().describe("Content template SID, e.g. HXxxxxxxxx"),
        },
      },
      async ({ sid }) => {
        const client = getTwilioClient();
        const content = await client.content.v1.contents(sid).fetch();
        const summary = {
          sid: content.sid,
          friendlyName: content.friendlyName,
          language: content.language,
          variables: content.variables,
          types: content.types,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    );
  },
};
