import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";
import { recordTouch } from "../resources/recent-records.js";

const OutputSchema = {
  success: z.boolean().describe("Always true on the success path — failures return isError instead."),
};

export const updateRecord: Tool = {
  name: "update_record",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "update_record",
      {
        title: "Salesforce Update Record",
        description:
          "Update fields on an existing record. Only send the fields you want to change. Call " +
          "describe_object first if unsure of a field's exact API name.",
        inputSchema: {
          objectName: z.string().min(1).describe('Object API name, e.g. "Contact".'),
          id: z.string().min(1).describe("Record id to update."),
          fields: z.record(z.string(), z.unknown()).describe("Field API name -> new value map."),
        },
        outputSchema: OutputSchema,
      },
      async ({ objectName, id, fields }) => {
        const r = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        });
        if (!r.ok) return salesforceError(r.status, r.body);
        recordTouch(objectName, id, "update");
        const data = { success: true };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default updateRecord;
