import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";

const OutputSchema = {
  searchRecords: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Matching records across every object type named in the SOSL RETURNING clause."),
};

export const search: Tool = {
  name: "search",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "search",
      {
        title: "Salesforce SOSL Search",
        description:
          "Run a SOSL full-text search against the connected Salesforce org. Use this instead " +
          "of query when you don't know which field or object holds a value — e.g. a phone " +
          "number that could be in Contact.Phone, Contact.MobilePhone, or Lead.Phone.",
        inputSchema: {
          sosl: z
            .string()
            .min(1)
            .describe(
              "SOSL search, e.g. \"FIND {4155551234} IN PHONE FIELDS RETURNING " +
                "Contact(Id, Name, Phone, MobilePhone)\"."
            ),
        },
        outputSchema: OutputSchema,
      },
      async ({ sosl }) => {
        const r = await sfFetch(`/search?q=${encodeURIComponent(sosl)}`);
        if (!r.ok) return salesforceError(r.status, r.body);
        const body = r.body as { searchRecords: Array<Record<string, unknown>> };
        const data = { searchRecords: body.searchRecords };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default search;
