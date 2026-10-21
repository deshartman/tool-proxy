import { z } from "zod";
import type { Prompt } from "@gtmi/toolproxy-connector/sdk";

// Same discover-before-you-act lesson as find-record-by-field.ts, applied to
// writes: check exact field API names + required fields before create/update
// instead of finding out via an INVALID_FIELD / REQUIRED_FIELD_MISSING error.

export const safeWriteRecord: Prompt = {
  name: "safe_write_record",
  register(server) {
    server.registerPrompt(
      "safe_write_record",
      {
        description:
          "Discover-then-write workflow for creating or updating a record without guessing " +
          "field API names or missing required fields.",
        argsSchema: {
          objectName: z.string().describe('Object API name to write to, e.g. "Contact".'),
          operation: z.enum(["create", "update"]).describe("Whether this is a create_record or update_record call."),
          intent: z
            .string()
            .describe('Plain-English description of what to set, e.g. "set the last name to Demo and phone to +15551234567".'),
        },
      },
      ({ objectName, operation, intent }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `${operation === "create" ? "Create" : "Update"} a ${objectName} record: ${intent}. ` +
                "Do this in order:\n" +
                `1. Call salesforce.describe_object with objectName="${objectName}" to confirm ` +
                "the exact field API names for every field you intend to set, and (for create) " +
                "which fields are required.\n" +
                `2. Call salesforce.${operation === "create" ? "create_record" : "update_record"} ` +
                "using only the confirmed field API names from step 1.\n" +
                "Do not guess a field API name — an incorrect one fails with INVALID_FIELD, and " +
                "a missing required field fails with REQUIRED_FIELD_MISSING.",
            },
          },
        ],
      })
    );
  },
};

export default safeWriteRecord;
