import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { sfFetch } from "../lib/client.js";
import { salesforceError } from "../lib/errors.js";
import { recordTouch } from "../resources/recent-records.js";

const OutputSchema = {
  id: z.string().describe("Id of the newly created record."),
  success: z.boolean().describe("Always true on the success path — failures return isError instead."),
};

export const createRecord: Tool = {
  name: "create_record",
  envKeys: ["SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_LOGIN_URL"],
  register(server) {
    server.registerTool(
      "create_record",
      {
        title: "Salesforce Create Record",
        description:
          "Create a new record. Call describe_object first to confirm required fields and " +
          "exact field API names — a wrong field name fails with INVALID_FIELD, a missing " +
          "required field fails with REQUIRED_FIELD_MISSING.",
        inputSchema: {
          objectName: z.string().min(1).describe('Object API name, e.g. "Contact".'),
          fields: z
            .record(z.string(), z.unknown())
            .describe('Field API name -> value map, e.g. {"LastName": "Demo", "Phone": "+15551234567"}.'),
        },
        outputSchema: OutputSchema,
      },
      async ({ objectName, fields }) => {
        const r = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}`, {
          method: "POST",
          body: JSON.stringify(fields),
        });
        if (!r.ok) return salesforceError(r.status, r.body);
        const body = r.body as { id: string; success: boolean };
        recordTouch(objectName, body.id, "create");
        const data = { id: body.id, success: body.success };
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export default createRecord;
