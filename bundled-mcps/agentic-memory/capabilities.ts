// Custom capabilities advertised on the MCP `initialize` response per
// MEMORY-MCP-INTERFACE.md §7. Wrapped under the first-class
// `extensions."agentic-memory"` field: MCP `2026-07-28` promotes `extensions`
// to a standard ServerCapabilities member — the sanctioned home for custom
// capability groups. (Earlier revisions used `experimental` because the SDK
// schema stripped unknown top-level keys; see the docstring on
// CreateMcpHttpServerOptions.capabilities in connector/src/sdk/http-server.ts.)
//
// The Controller-side handoff for this shape lives in
// docs/AGENTIC-MEMORY-MOCK.md — the Controller reads `extensions."agentic-memory"`.
const capabilities = {
  extensions: {
    "agentic-memory": {
      protocolVersion: "2026-07",
      identity: {
        supported: true,
        maxAliases: 100,
        supportsBatchLookup: false,
      },
      memory: {
        episodic: {
          supported: true,
          maxQueryLength: 2000,
          maxResults: 50,
          supportsVectorSearch: false,
          supportsRecencyScoring: true,
          batchAppend: false,
        },
        semantic: {
          supported: true,
          maxResolvedSizeBytes: 1_048_576,
          maxSourceRefs: 1000,
          supportsAgentFlush: true,
          supportsIdentityMerge: true,
          supportsPruneRefs: true,
        },
      },
      unknownFieldBehavior: "ignore" as const,
    },
  },
};

export default capabilities;
