// Custom capabilities advertised on the MCP `initialize` response per
// MEMORY-MCP-INTERFACE.md §7. Wrapped under `experimental."agentic-memory"`
// because MCP's ServerCapabilitiesSchema strips unknown top-level keys —
// see the docstring on CreateMcpHttpServerOptions.capabilities in
// packages/connector/src/sdk/http-server.ts.
//
// The Controller-side handoff for this shape lives in
// docs/AGENTIC-MEMORY-MOCK.md.
const capabilities = {
  experimental: {
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
