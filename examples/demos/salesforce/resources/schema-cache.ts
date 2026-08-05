import type { Resource } from "@mcp-shim/connector/sdk";
import { ResourceTemplate } from "@modelcontextprotocol/server";

// Per-object describe() cache, populated by tools/describe-object.ts. Lets a
// procedure `resources/read salesforce://schema/{objectName}` for cached
// field names instead of a tool round-trip. Empty for an object until
// describe_object has been called for it at least once this session.

interface FieldSummary {
  name: string;
  label: string;
  type: string;
}

const schemaCache = new Map<string, FieldSummary[]>();

export function cacheSchema(objectName: string, fields: FieldSummary[]): void {
  schemaCache.set(objectName, fields);
}

export function getCachedSchema(objectName: string): FieldSummary[] | undefined {
  return schemaCache.get(objectName);
}

export const schemaCacheResource: Resource = {
  name: "schema_cache",
  register(server) {
    server.registerResource(
      "schema_cache",
      new ResourceTemplate("salesforce://schema/{objectName}", {
        list: async () => ({
          resources: Array.from(schemaCache.keys()).map((objectName) => ({
            uri: `salesforce://schema/${objectName}`,
            name: `schema_cache:${objectName}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Cached Salesforce Object Schema",
        description:
          "Field names/labels/types from the last salesforce.describe_object call for this " +
          "object. Empty until describe_object has been called for this object at least once " +
          "this session.",
        mimeType: "application/json",
      },
      async (uri, { objectName }) => {
        const key = Array.isArray(objectName) ? objectName[0] : objectName;
        const fields = schemaCache.get(key ?? "") ?? [];
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ objectName: key, fields }, null, 2),
            },
          ],
        };
      }
    );
  },
};

export default schemaCacheResource;
