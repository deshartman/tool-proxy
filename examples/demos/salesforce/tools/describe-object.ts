import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";
import { cacheSchema } from "../resources/schema-cache.js";

const OutputSchema = {
  fields: z
    .array(
      z.object({
        name: z.string().describe('Field API name, e.g. "MobilePhone".'),
        label: z.string().describe("Field display label."),
        type: z.string().describe('Field type, e.g. "phone", "string", "reference".'),
      })
    )
    .describe(
      "Trimmed field list — full describe() carries hundreds of properties per field, " +
        "most unused for query/write authoring."
    ),
};

export const describeObject: Tool = {
  name: "describe_object",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "describe_object",
      {
        title: "Salesforce Describe Object",
        description:
          "List field names/labels/types for a Salesforce object. Call this before query/" +
          "search/create_record/update_record when you're not certain of a field's exact API " +
          "name — Salesforce has no wildcard field selection, so guessing wrong fails the call.",
        inputSchema: {
          objectName: z.string().min(1).describe('Object API name, e.g. "Contact" or "My_Custom_Object__c".'),
        },
        outputSchema: OutputSchema,
      },
      async ({ objectName }) => {
        const r = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}/describe`);
        if (!r.ok) return salesforceError(r.status, r.body);
        const body = r.body as { fields: Array<{ name: string; label: string; type: string }> };
        const fields = body.fields.map((f) => ({ name: f.name, label: f.label, type: f.type }));
        cacheSchema(objectName, fields);
        const data = { fields };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default describeObject;
