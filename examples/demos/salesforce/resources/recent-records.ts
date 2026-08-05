import type { Resource } from "@mcp-shim/connector/sdk";

// In-process tracker of the last records touched by get_record /
// create_record / update_record / delete_record. Exposes the most-recent 16
// as a canonical read-only surface at `salesforce://records/recent`, so a
// procedure can reference "the record I just created" without repeating the
// id. Restart wipes it — in-memory only, same as crm's recent-lookups.ts.

interface RecordTouch {
  objectName: string;
  id: string;
  operation: "get" | "create" | "update" | "delete";
  at: string;
}

const recentRecords: RecordTouch[] = [];

export function recordTouch(objectName: string, id: string, operation: RecordTouch["operation"]): void {
  recentRecords.unshift({ objectName, id, operation, at: new Date().toISOString() });
  if (recentRecords.length > 16) recentRecords.length = 16;
}

export const recentRecordsResource: Resource = {
  name: "recent_records",
  register(server) {
    server.registerResource(
      "recent_records",
      "salesforce://records/recent",
      {
        title: "Recent Salesforce Records",
        description:
          "The most recent records touched via salesforce.get_record / create_record / " +
          "update_record / delete_record (in-process, capped at 16, newest first).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify({ recent: [...recentRecords] }, null, 2),
          },
        ],
      })
    );
  },
};

export default recentRecordsResource;
