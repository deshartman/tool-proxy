# MongoDB Atlas Vector Search vs pgvector — investigation notes

**Date:** 2026-06-16
**Scope:** Research-only. No code changes. Companion to [VOYAGEAI.md](VOYAGEAI.md). Question: should the [Enterprise Knowledge bundle](../../bundles/enterprise-knowledge/) consider MongoDB (Atlas) instead of pgvector for the vector store layer?
**Sources:** [mongodb.com/products/platform/atlas-vector-search](https://www.mongodb.com/products/platform/atlas-vector-search), [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector), and the bundle's own [`storage.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py).

---

## TL;DR

**Stay on pgvector** for this product. MongoDB Atlas Vector Search is technically very competitive (and in some axes — hybrid search, filter pushdown, multimodal — slightly ahead), **but its deployment shape collides head-on with the connector's load-bearing trust model**: Atlas is cloud-only (self-hosted MongoDB Community/Enterprise does not ship vector search), so adopting it would mean **shipping every customer document chunk out of the customer's network and into MongoDB Cloud**. That's not a free swap — it's a different security posture.

The gap isn't capability; it's where the data lives. pgvector runs as an extension inside whatever Postgres the customer already operates (likely inside their VPC, often already approved by their security team). Atlas does not offer that shape.

If a customer specifically *wants* a managed vector store and is fine with the data-residency change, there's nothing technically wrong with adding a `EK_VECTOR_STORE=mongodb` provider alongside `pgvector`. But the **default** should remain pgvector for the same reason the connector is outbound-only: minimum surprise for the customer's security review.

---

## What's actually being compared

This is a different layer from the [Voyage AI question](VOYAGEAI.md). Voyage was about *which model does the embedding*. This is about *where the vectors get stored and searched*. The bundle's storage layer today (per [`storage.py:33`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L33)) is:

```
LlamaIndex (orchestration) → llama-index-vector-stores-postgres → psycopg → Postgres + pgvector
```

The question is whether to swap `llama-index-vector-stores-postgres` for `llama-index-vector-stores-mongodb` and point at MongoDB Atlas instead.

---

## Capability matrix

| | pgvector | MongoDB Atlas Vector Search |
|---|---|---|
| **Deployment shape** | Extension on **any** Postgres ≥ 13. Customer's existing DB, customer's VPC, customer's backups. | **Atlas-only** (managed cloud). Community/Enterprise self-hosted MongoDB does *not* support vector search. |
| **License** | OSI (PostgreSQL License) | Proprietary managed service. SSPL on the underlying server. |
| **Index types** | HNSW, IVFFlat | HNSW, Flat |
| **Max dims** | 2,000 (full-precision) / 4,000 (halfvec) / 64,000 (bit) | 4,096 |
| **Quantization** | halfvec, bit, sparsevec — schema-level types | Scalar, binary, automatic — managed |
| **Distance metrics** | L2, inner product, cosine, L1, Hamming, Jaccard | Euclidean, cosine, dot product |
| **Filter pushdown** | Standard SQL `WHERE` plus PostgreSQL FTS for hybrid lexical | Rich Mongo aggregation pipeline; **`$vectorSearch` integrates natively with `$match`, `$lookup`, geospatial, etc.** |
| **Hybrid search** | pgvector + `tsvector`/`tsquery` (workable, you wire it yourself) | First-class hybrid lexical + vector + filter in one stage. Notably more polished. |
| **Operational story** | Just Postgres. HNSW build needs `maintenance_work_mem`; recall vs throughput tunable. Familiar ops. | Fully managed (cluster sizing, replication, upgrades). Less to operate; less to control. |
| **LlamaIndex integration** | `llama-index-vector-stores-postgres` (used today) | `llama-index-vector-stores-mongodb` (community-maintained, similar shape) |
| **Egress destination** | None — DB lives wherever the customer puts it. | Atlas region (AWS / Azure / GCP). All chunks + vectors leave the customer's network. |

**Where Atlas legitimately wins on capability:**
1. **Native hybrid + filter in one pipeline.** If the bundle's roadmap includes "find chunks from sources tagged `legal:contracts` AND vector-similar to X AND geo-tagged near Y", Atlas does this in one `$vectorSearch` + `$match` aggregation. With pgvector, you compose it in SQL — workable, more code.
2. **Multimodal-friendly metadata.** Mongo's document model carries arbitrary nested JSON without schema change; pgvector + Postgres can do `jsonb` but it's less ergonomic when metadata varies wildly per source kind.
3. **Higher max dim out of the box.** 4,096 vs pgvector's 2,000 (full-precision). Matters if you start using `text-embedding-3-large` (3,072) or `voyage-multimodal-3.5` at full dim. *Note: pgvector's halfvec covers up to 4,000, so the gap is narrower than the headline number.*

**Where pgvector legitimately wins:**
1. **Same DB as everything else.** Source metadata ([`metadata.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/metadata.py)), migrations ([`migrations/`](../../bundles/enterprise-knowledge/migrations/)), and vectors are all in one Postgres. One DSN ([`EK_PGVECTOR_DSN`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/settings.py)), one set of backups, one transactional boundary.
2. **No new vendor relationship.** Customer's existing Postgres operator owns it. No Atlas account to provision per customer, no new billing, no new SOC 2 to file.
3. **Self-hostable, period.** Atlas Vector Search has no on-prem option. For customers in regulated verticals (healthcare, finance, defense) where the document corpus genuinely *cannot* leave the VPC, pgvector is the only one of the two that's even a candidate.
4. **Proven sufficient for current scale.** Per-source-id table model in [`storage.py:_vector_store()`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L76-L86) is dead simple and works. There's no observed bottleneck driving a switch.

---

## How this collides with the connector's architecture

The repo's [CLAUDE.md](../../CLAUDE.md) calls out the connector's outbound-only invariant repeatedly. The whole story is:

> The connector opens **no inbound ports**. … The connector itself stays a thin dispatcher. … *In production, each connector deployment is its own container — same yaml shape, just one container per `tunnel.name`.*

Today, when the EK bundle runs, the customer's documents:
1. Get fetched by [`readers.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py) inside the connector container.
2. Get chunked locally (`SentenceSplitter` in [`storage.py:41`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L41)).
3. Get sent — *as the chunked text* — to the embedder. With `EK_EMBEDDER=local` they never leave the box. With `EK_EMBEDDER=openai` only the *embedding API call* leaves; vectors come back and store locally.
4. Get persisted (text + vector + metadata) into the customer's pgvector — also typically inside the customer VPC.

Switching to Atlas changes step 4 fundamentally: **the chunked source text + vectors + metadata now live in MongoDB Cloud, indefinitely**. That's a categorically larger egress surface than even the OpenAI embedder posture, where only transient API calls leave.

For the in-bundle architectural note — [`embedder.py:85-99`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py#L85-L99) explicitly pins egress to `https://api.openai.com/v1` and refuses to honor overrides — adopting Atlas would require an analogous pin (`*.mongodb.net`?) and a much more involved customer security review. Whether that's worth doing depends entirely on whether the *capability* gap (point 1 above: native hybrid with filters) becomes load-bearing for the product. Today it isn't.

---

## What a swap would actually entail (sketch only — no code)

If a customer asked for it:

1. **Storage layer:** Replace [`PGVectorStore.from_params(...)` in `_vector_store()`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L76-L86) with the equivalent `MongoDBAtlasVectorSearch` constructor from `llama-index-vector-stores-mongodb`. Per-source-id "table" becomes a per-source-id collection (or one collection with a `source_id` filter — Atlas's filter pushdown makes the latter cheaper than the per-table approach used today).
2. **Migrations:** Drop the SQL [`migrations/`](../../bundles/enterprise-knowledge/migrations/) machinery. Atlas indexes are JSON definitions registered via Mongo admin commands. The bundle would need to ensure the `vectorSearch` index exists on first connect (idempotent), with the right `numDimensions` (still pulled from `_embedder.embed_dim`) and similarity metric.
3. **Settings:** Add `EK_MONGODB_URI` alongside / instead of `EK_PGVECTOR_DSN`, plus an `EK_VECTOR_STORE` discriminator (`pgvector` | `mongodb`) following the same pluggable-provider pattern as `EK_EMBEDDER`. Two providers max — the architectural shape from `embedder.py` lifts cleanly.
4. **Egress allow-list:** Document the new destination(s) in `.env.example` and ideally pin them the way OpenAI is pinned today.
5. **Re-index on switch:** Same constraint as the embedder — switching vector stores is a rebuild. Worth surfacing in `register_source` / `refresh` the same way embedder mismatch is surfaced today ([`storage.py:175-181`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L175-L181)).

Effort estimate: ~150-300 LoC plus a parallel migration story. Not trivial. Not insurmountable. The reason not to do it is *posture*, not effort.

---

## Recommendation (one paragraph)

**Default stays pgvector.** It's already wired, sufficient for current scale, and matches the connector's "stays inside the customer's network" posture without exception. Add a MongoDB Atlas provider only if a specific customer asks for it AND has already accepted the data-residency change for unrelated reasons (e.g. they're already a MongoDB shop and want one less DB to operate). When that ask comes, the existing pluggable-provider pattern in [`embedder.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py) — lifted as `EK_VECTOR_STORE=pgvector|mongodb` — is the right shape. **Do not** swap the default; the trust-boundary regression isn't worth the modest hybrid-query ergonomic win.

---

## Open questions (not investigated)

- Is **MongoDB Enterprise Advanced** (the on-prem licensed tier) gaining vector search in any roadmap window? If yes, this calculation changes — an on-prem MongoDB with vector search has the same trust posture as pgvector.
- What's the actual recall delta between pgvector HNSW and Atlas's HNSW on a typical EK corpus? Both are HNSW; results should be near-identical at matched parameters, but vendor-tuned defaults differ.
- For larger deployments (10s of millions of chunks), does pgvector's HNSW index build time become operationally painful? Atlas hides this behind their managed plane, which becomes a real win at scale even ignoring the capability axis.
- Does the per-source-id table model in [`storage.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py) scale to thousands of registered sources? At some point the catalog overhead would push toward a single-table-with-`source_id`-filter model — which Atlas already favors and pgvector handles fine but isn't currently structured for.
