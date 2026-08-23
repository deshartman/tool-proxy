# Knowledge base — the MCP interface to implement

Read this if your deployment needs retrieval: a corpus of documents, tickets,
policies or transcripts that a procedure should be able to search.

Three things to know before reading further:

1. **The connector does not ship a knowledge base.** There is no retrieval
   stack, no vector store, and no embedding model inside it, by design — see
   the "no LLM, no agent loop, no document handling" invariant in
   [`CLAUDE.md`](../CLAUDE.md).
2. **You build the knowledge base and expose it as an ordinary MCP.** Your
   corpus, embedding model, chunking strategy, access-control rules and
   retention policy are yours. The connector dispatches tool calls to it the
   same way it dispatches to any other MCP.
3. **Only one tool is required: `knowledge_query`.** Everything else in this
   document is optional and exists because one particular implementation
   happened to need it.

Why the interface rather than an implementation: a knowledge base's valuable
parts — which documents, which access rules, which model, which retention
window — are exactly the parts that can't be shipped from outside your
organisation. What *can* be specified is the shape of the retrieval call, so
that a controller-side procedure written against `knowledge_query` works
regardless of what answers it.

## Which delivery path to pick

|  | **Type 1 drop-in** | **Type 2 external** |
|---|---|---|
| Language | Node/TypeScript only | Any |
| Lands at | `customer-mcps/<name>/tools/*.ts` | Registered in the controller UI (URL or command + auth shape) |
| Transport | Synthesized HTTP child, spawned by the connector | streamable-http / SSE / stdio |
| Creds | Controller `creds-request`, or `dir/.env` in dev | Request headers (HTTP) or env (stdio) |
| **Approval-gated?** | **Yes** — see below | No |
| `outputSchema` | **Required** — a boot-time check logs an error per tool without one | Optional; passed through verbatim |
| Best for | A thin MCP wrapper over an existing internal search API | An existing retrieval service, or a non-Node stack |

Both paths work today with no connector changes.

### The approval gate — read this before you file a bug

A Type 1 drop-in is **approval-gated**. The connector spawns your MCP, calls
`tools/list`, and then **withholds those tools from the manifest** until a
controller operator approves the MCP. Until that click, your tools will not
appear controller-side, even though the connector's inspector shows the child
running and healthy.

This is intentional — a folder appearing under `customer-mcps/` is a
*proposal*, and the operator's approval is the *acceptance*. Two different
people hold the two keys. But it means a working implementation can look
broken for reasons that have nothing to do with your code. If your tools are
missing controller-side, check for a pending-approval entry there first.

Type 2 MCPs are not gated: registering one through the controller UI is
already an operator action, so acceptance has happened by the time the
connector hears about it.

## `knowledge_query` — REQUIRED

Retrieval only. No fetching, crawling or indexing at query time — a query
that triggers an index build will blow the caller's timeout.

Input:

```json
{
  "type": "object",
  "properties": {
    "source_id": { "type": "string" },
    "query":     { "type": "string" },
    "k":         { "type": "integer", "minimum": 1, "default": 5 }
  },
  "required": ["source_id", "query"],
  "additionalProperties": false
}
```

Response — **the field names are the contract.** Controller-side procedures
reference them directly (`{{ hydrate:<server>.knowledge_query.chunks }}`), so
renaming a field breaks procedures, while changing what fills it does not:

```json
{
  "chunks": [
    {
      "text": "…retrieved passage…",
      "score": 0.82,
      "citation": {
        "source_id": "abc123",
        "doc_id": "…",
        "char_offset": 0
      }
    }
  ],
  "source_meta": {
    "source_id": "abc123",
    "k": 5,
    "query": "…echoed…",
    "stale": true,
    "last_error": "…"
  }
}
```

- **`source_id` is opaque to the caller.** If you have a single corpus, accept
  any value, or a literal like `"default"` — just document which. If your
  corpus is partitioned, these are your partition keys, and implementing
  `sources_fetch` (below) is how an operator discovers valid values.
- **`score`** — higher is more relevant. The scale is yours; nothing compares
  scores across sources.
- **`citation`** is what makes a model's answer attributable. Populate it even
  if `doc_id` has to be synthetic — an answer a human can't trace back is
  worth much less than one they can.
- **`stale` / `last_error`** are optional, and appear only when the index is
  known-degraded but still serving. Include them if your implementation can
  tell the difference; omit them entirely otherwise. Do not send
  `stale: false` on every healthy response — absence already means healthy.
- **Declare `outputSchema`.** Required for a Type 1 drop-in; strongly
  recommended for Type 2 so controller-side `{{ hydrate: }}` references
  type-check instead of failing at runtime.

## `sources_fetch` — OPTIONAL

A zero-argument inventory of what's indexed. Input:
`{"type":"object","properties":{},"additionalProperties":false}`. Returns an
array:

```json
[
  {
    "source_id": "abc123",
    "url": "…",
    "kind": "gdrive",
    "indexed_at": "2026-08-23T10:00:00Z",
    "doc_count": 412,
    "status": "indexed",
    "last_error": null,
    "last_attempted_at": null
  }
]
```

Return failed sources **alongside** healthy ones, distinguished by `status`,
rather than omitting them — the controller filters, and a source that vanishes
from the inventory is indistinguishable from one that was never registered.

Implement this if your corpus is partitioned and an operator needs to discover
valid `source_id` values. Skip it for a single fixed corpus.

## `sources_refresh` — OPTIONAL

Re-index one source. Input `{source_id, force?}`, where `force` defaults to
`false` — re-embed only what changed, versus re-embed everything.

Skip this entirely when an external pipeline owns indexing. If your nightly
job already keeps the index current, a `sources_refresh` tool that returns
"not supported" is worse than no tool at all: the model will keep trying it.

## `<product>_register` — OPTIONAL

One pattern among several, not a requirement. The bundled implementation
generated one registration tool per source kind — `local_register`,
`gdrive_register` — each taking `{url}` and returning `{source_id, status}`
with `status` one of `indexed` | `already_indexed` | `failed`.

A customer whose sources are configured out-of-band needs no registration tool
at all.

If you do implement one, one detail from the bundled version is worth copying:
when a URL doesn't match the tool's expected shape, reject it with a message
that **names the tool that would accept it**. A model can act on "that's a
Google Drive URL, use `gdrive_register`"; it cannot act on "invalid URL".

## Errors

Return a tool-level rejection as a **normal MCP result with `isError: true`**
and a message the model can act on. Do not throw a transport error.

The connector relays an `isError` result verbatim, so the message reaches the
controller's model, which reads it and adapts — retries with a different
`source_id`, asks the caller to narrow the query, gives up gracefully. A
thrown transport error instead surfaces as a dispatch failure, which the model
cannot distinguish from the MCP being down.

The distinction is load-bearing on the connector side too: "the tool ran and
rejected the input" and "the transport died" are different events, and
collapsing them loses the difference in the connector's logs as well as in the
model's behaviour.

## Credentials

Never commit credentials into a drop-in folder. The connector supplies env
from the controller via the `creds-request` / `creds-update` frames; a Type 1
drop-in declares the keys it needs with `envKeys` on the tool, and those key
*names* (never values) are what the connector asks the controller to fill:

```ts
export const knowledgeQuery: Tool = {
  name: "knowledge_query",
  envKeys: ["SEARCH_API_TOKEN"],
  register(server) { /* … */ },
};
```

In dev, a `.env` in the drop-in folder works as an escape hatch and is loaded
into that child process only. Inspector session creds (loopback-only, 12 h
TTL) are the other dev path — see
[`docs/INSPECTOR.md`](INSPECTOR.md) §"Right pane — MCP creds view".

Full authoring walkthrough: [`docs/AUTHOR-LOCAL-MCP.md`](AUTHOR-LOCAL-MCP.md).

## A minimal conforming implementation

`knowledge_query` alone, as a Type 1 drop-in wrapping an internal search
endpoint. Drop this at `customer-mcps/knowledge/tools/knowledge-query.ts` —
the folder name becomes the MCP name, and the connector discovers it at boot.

```ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const SEARCH_URL = process.env.SEARCH_URL ?? "http://localhost:8080/search";

const OutputSchema = {
  chunks: z.array(z.object({
    text: z.string().describe("The retrieved passage."),
    score: z.number().describe("Relevance; higher is better."),
    citation: z.object({
      source_id: z.string(),
      doc_id: z.string(),
      char_offset: z.number(),
    }).describe("Where the passage came from, for attribution."),
  })).describe("Passages ordered most-relevant first. Empty when nothing matched."),
  source_meta: z.object({
    source_id: z.string(),
    k: z.number(),
    query: z.string(),
  }).describe("Echoed request parameters."),
};

export const knowledgeQuery: Tool = {
  name: "knowledge_query",
  envKeys: ["SEARCH_API_TOKEN"],
  register(server) {
    server.registerTool(
      "knowledge_query",
      {
        title: "Knowledge Query",
        description:
          "Retrieves passages from the internal knowledge base that are relevant to " +
          "`query`. Returns { chunks[], source_meta } — each chunk carries the passage " +
          "text, a relevance score, and a citation for attribution. Retrieval only; " +
          "does not index. An empty chunks[] means nothing matched, which is a normal " +
          "answer, not an error.",
        inputSchema: {
          source_id: z.string().describe('Corpus to search. Use "default".'),
          query: z.string().describe("Natural-language question or search text."),
          k: z.number().int().min(1).default(5).describe("Max passages to return."),
        },
        outputSchema: OutputSchema,
      },
      async ({ source_id, query, k }) => {
        const res = await fetch(SEARCH_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.SEARCH_API_TOKEN ?? ""}`,
          },
          body: JSON.stringify({ q: query, limit: k }),
        });

        if (!res.ok) {
          // Tool-level rejection: a result the model can read and act on,
          // NOT a thrown transport error. See "Errors" above.
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Search backend returned ${res.status}. The index may be rebuilding; retry shortly.`,
            }],
          };
        }

        const hits = await res.json() as Array<{ text: string; score: number; id: string }>;
        const body = {
          chunks: hits.map((h) => ({
            text: h.text,
            score: h.score,
            citation: { source_id, doc_id: h.id, char_offset: 0 },
          })),
          source_meta: { source_id, k, query },
        };

        return {
          structuredContent: body,
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        };
      },
    );
  },
};

export default knowledgeQuery;
```

That is a complete, conforming knowledge MCP. `zod` and the SDK import resolve
from the workspace root — no `package.json` needed in the folder unless you add
a third-party SDK. Restart the connector (or use the controller's **Refresh
local MCPs**), approve the MCP controller-side, and `knowledge_query` is
callable from a procedure.

## What is deliberately not here

**No reference implementation.** Shipping one would mean shipping an opinion
about embedding model, vector store and chunking — the opinions this interface
exists to avoid — and it would rot, because nothing in this repo would exercise
it. The ~90-line example above is the whole reference.

**No mandated storage, model, or chunking.** Whether `source_id` is a hash or
a UUID, whether registration is synchronous, how you authenticate to your own
corpus, how long you retain embeddings — all yours. The reference response
shapes above are a contract about *field names*, not about how you fill them.
