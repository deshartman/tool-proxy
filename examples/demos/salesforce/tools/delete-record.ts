import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";
import { recordTouch } from "../resources/recent-records.js";

const OutputSchema = {
  success: z.boolean().describe("Always true on the success path — failures return isError instead."),
};

export const deleteRecord: Tool = {
  name: "delete_record",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "delete_record",
      {
        title: "Salesforce Delete Record",
        description: "Permanently delete a record by object type + id. Not reversible via this tool.",
        inputSchema: {
          objectName: z.string().min(1).describe('Object API name, e.g. "Contact".'),
          id: z.string().min(1).describe("Record id to delete."),
        },
        outputSchema: OutputSchema,
      },
      async ({ objectName, id }) => {
        const r = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!r.ok) return salesforceError(r.status, r.body);
        recordTouch(objectName, id, "delete");
        const data = { success: true };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default deleteRecord;
