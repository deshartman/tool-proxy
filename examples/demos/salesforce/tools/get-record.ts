import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";
import { recordTouch } from "../resources/recent-records.js";

const OutputSchema = {
  record: z.record(z.string(), z.unknown()).describe("Every field on the record, as returned by Salesforce."),
};

export const getRecord: Tool = {
  name: "get_record",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "get_record",
      {
        title: "Salesforce Get Record",
        description:
          "Fetch a single record by object type + id. Returns every field — unlike query, no " +
          "field list is needed.",
        inputSchema: {
          objectName: z.string().min(1).describe('Object API name, e.g. "Contact".'),
          id: z.string().min(1).describe('Record id, e.g. "003bm00001fA42EAAS".'),
        },
        outputSchema: OutputSchema,
      },
      async ({ objectName, id }) => {
        const r = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}`);
        if (!r.ok) return salesforceError(r.status, r.body);
        recordTouch(objectName, id, "get");
        const data = { record: r.body as Record<string, unknown> };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default getRecord;
