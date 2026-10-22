import type { Resource } from "@gtmi/toolproxy-connector/sdk";

// In-process tracker of recently-looked-up customer phones. `get_customer`
// and `get_recent` push into this on every successful lookup; the resource
// exposes the most-recent 16 as a canonical read-only surface at
// `crm://lookups/recent`. Same pattern as sample's `uuids-recent.ts`.
//
// Procedures pull this via `resources/read` when they want "who did this
// connector talk to lately" without burning a tool call. Restart wipes it —
// this is in-memory only; persistence lives on the controller side.

const recentLookups: { phone: string; at: string }[] = [];

export function recordLookup(phone: string): void {
  recentLookups.unshift({ phone, at: new Date().toISOString() });
  if (recentLookups.length > 16) recentLookups.length = 16;
}

export const recentLookupsResource: Resource = {
  name: "recent_lookups",
  register(server) {
    server.registerResource(
      "recent_lookups",
      "crm://lookups/recent",
      {
        title: "Recent Customer Lookups",
        description: "The most recent phones looked up via crm.get_customer / crm.get_recent (in-process, capped at 16, newest first).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ recent: [...recentLookups] }, null, 2),
        }],
      }),
    );
  },
};

export default recentLookupsResource;
