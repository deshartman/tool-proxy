import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";

const OutputSchema = {
  records: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Matching records, shaped by the SOQL SELECT clause."),
  totalSize: z.number().describe("Total number of matching records."),
  done: z.boolean().describe("False if the result is paginated and more records remain (pagination not followed by this tool)."),
};

export const query: Tool = {
  name: "query",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "query",
      {
        title: "Salesforce SOQL Query",
        description:
          "Run a SOQL query against the connected Salesforce org. SOQL requires an explicit " +
          "field list (no SELECT *) — call describe_object first if you're unsure of a field's " +
          "API name.",
        inputSchema: {
          soql: z
            .string()
            .min(1)
            .describe("SOQL query, e.g. \"SELECT Id, Name FROM Contact WHERE Phone = '+15551234567'\"."),
        },
        outputSchema: OutputSchema,
      },
      async ({ soql }) => {
        const r = await sfFetch(`/query?q=${encodeURIComponent(soql)}`);
        if (!r.ok) return salesforceError(r.status, r.body);
        const body = r.body as { records: Array<Record<string, unknown>>; totalSize: number; done: boolean };
        const data = { records: body.records, totalSize: body.totalSize, done: body.done };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default query;
