import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

// Encodes a lesson learned the hard way: a plain-English field hint ("phone
// number") doesn't map to one obvious Salesforce field API name (Phone vs
// MobilePhone vs OtherPhone). This prompt tells the caller to check first
// (describe_object) rather than guess and potentially miss the record.

export const findRecordByField: Prompt = {
  name: "find_record_by_field",
  register(server) {
    server.registerPrompt(
      "find_record_by_field",
      {
        description:
          "Discover-then-query workflow for finding a record by a plain-English field hint " +
          '(e.g. "phone number") without guessing the exact API field name.',
        argsSchema: {
          objectName: z.string().describe('Object API name to search, e.g. "Contact".'),
          fieldHint: z.string().describe('Plain-English description of the field to match, e.g. "phone number" or "email".'),
          value: z.string().describe("The value to search for."),
        },
      },
      ({ objectName, fieldHint, value }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Find the ${objectName} record where "${fieldHint}" matches "${value}". ` +
                "Do this in order:\n" +
                `1. Call salesforce.describe_object with objectName="${objectName}" to see the ` +
                `real field API names — "${fieldHint}" does not necessarily map to one obvious ` +
                "field (e.g. a phone number could live in Phone, MobilePhone, or OtherPhone).\n" +
                `2. If exactly one field plausibly matches "${fieldHint}", call salesforce.query ` +
                "with a SOQL WHERE clause on that field.\n" +
                "3. If more than one field plausibly matches, call salesforce.search (SOSL) " +
                "across all of them instead of guessing which one holds the value.\n" +
                "Do not guess a field name without calling describe_object first.",
            },
          },
        ],
      })
    );
  },
};

export default findRecordByField;
