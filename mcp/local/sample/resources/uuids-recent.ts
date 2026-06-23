import type { Resource } from "@mcp-shim/connector/sdk";

// Worked example for the v1.2 SDK Resource surface. Surfaces the most-recent
// 16 UUIDs the `uuid` tool minted as a single read-only resource at
// `sample://uuids/recent`.
//
// Read-only, non-side-effecting state belongs on the resource surface.
// Procedures pull canonical context via `resources/read` instead of burning
// a tool call. Tools stay for the side-effecting case (the `uuid` tool itself
// stays a tool — it allocates a new UUID on every call).

const recentUuids: string[] = [];
export function recordUuid(value: string): void {
  recentUuids.unshift(value);
  if (recentUuids.length > 16) recentUuids.length = 16;
}

export const uuidsRecent: Resource = {
  name: "recent_uuids",
  register(server) {
    server.registerResource(
      "recent_uuids",
      "sample://uuids/recent",
      {
        title: "Recent UUIDs",
        description: "The most recent UUIDs minted by sample-mcp-server.uuid (in-process, capped at 16).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ recent: [...recentUuids] }, null, 2),
        }],
      }),
    );
  },
};
