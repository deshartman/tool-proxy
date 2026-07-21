# Voyage AI vs / with LlamaIndex — investigation notes

**Date:** 2026-06-15
**Scope:** Research-only. No code changes. Purpose is to understand whether Voyage AI replaces LlamaIndex, complements it, or hinders the [Enterprise Knowledge bundle](../../bundles/enterprise-knowledge/) we already ship.
**Sources:** [voyageai.com](https://www.voyageai.com/), [docs.voyageai.com/docs/embeddings](https://docs.voyageai.com/docs/embeddings), [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing), and the bundle's own `embedder.py` / `pyproject.toml`. (LlamaIndex's own docs were blocked by corporate Zscaler; conclusions about the LlamaIndex integration shape are inferred from the existing `llama-index-embeddings-openai` / `llama-index-embeddings-huggingface` pattern in this repo, not read from upstream docs.)

---

## TL;DR

**Voyage AI complements LlamaIndex — it does not replace it.** They sit at different layers of a RAG stack:

- **LlamaIndex** = orchestration framework (loaders, chunkers, indexes, retrievers, query engines, postprocessors, vector store adapters). Glue code.
- **Voyage AI** = a **model provider** (embeddings + rerankers) that LlamaIndex calls. Same architectural slot as OpenAI's `text-embedding-3-*` or HuggingFace's `bge-small-en-v1.5` already wired into [`embedder.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py).

For *this* repo, adopting Voyage would be a **third provider entry in the existing `EK_EMBEDDER` registry**, plus a brand-new postprocessor slot for the reranker (which neither OpenAI nor HuggingFace currently fills). The customer-facing surface (yaml entry, `.env`) is unchanged in shape — `EK_EMBEDDER=voyage` and `VOYAGE_API_KEY=…` is roughly all that lands in `mcp/bundled/enterprise-knowledge/.env`.

---

## What Voyage AI actually sells

Two product lines, both consumed as HTTP API calls:

### 1. Embedding models

| Model | Dim (default) | Context | Price (per 1M tokens) | Notes |
|---|---:|---:|---:|---|
| `voyage-4-large` | 1024 (256/512/2048 selectable) | 32K | $0.12 | "best general-purpose + multilingual" |
| `voyage-4` | 1024 | 32K | $0.06 | general-purpose |
| `voyage-4-lite` | 1024 | 32K | $0.02 | speed/cost optimized |
| `voyage-context-3` | 1024 | 32K | $0.18 | chunk-level + global doc context |
| `voyage-code-3` | 1024 | 32K | $0.18 | code retrieval |
| `voyage-multimodal-3.5` | — | — | $0.12 text / $0.60 per Bn pixels | text + image |
| `voyage-finance-2` / `voyage-law-2` / `voyage-multilingual-2` / `voyage-code-2` | varies | up to 32K | $0.12 | domain-specialized (legacy) |

200M free tokens per account on the 4-series; Batch API gives a 33% discount on async workloads.

For comparison, OpenAI's current default in this repo:
- `text-embedding-3-small`: 1536 dim, 8K context, $0.02/M
- `text-embedding-3-large`: 3072 dim, 8K context, $0.13/M

**Differentiators worth flagging:**
- **32K context** vs OpenAI's 8K. Bigger chunks survive embedding without splitting.
- **Selectable output dims** (256/512/1024/2048) + binary/int8 quantization → smaller pgvector columns, smaller index footprint.
- **Domain-tuned variants** (code, finance, legal). For an MCP that surfaces legal SOPs or developer runbooks, this is genuinely a quality lever, not just marketing.
- **Multimodal**. OpenAI's embedding endpoint doesn't do image input; Voyage does. Relevant if/when EK starts ingesting screenshots, diagrams, or scanned PDFs as image-bearing content.

### 2. Rerankers

| Model | Price (per 1M tokens) | Free |
|---|---:|---:|
| `rerank-2.5` / `rerank-2.5-lite` | $0.05 / $0.02 | 200M tokens |

**This is the more interesting half.** A reranker is a *cross-encoder* that re-scores the top-K results from a vector retriever using the query and candidate text together (vs the bi-encoder embeddings, which encode each independently). Relevance lift is typically meaningful — the standard RAG pattern is `retrieve top-50 → rerank → return top-10`.

The current bundle has **no reranker** at all. [`storage.py:185`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L185) does a single-shot vector retrieval (`index.as_retriever(similarity_top_k=k).retrieve(query_text)`) and returns directly. That's fine for a v1, but it's the layer where retrieval quality is most easily improved without rebuilding the index.

---

## What LlamaIndex actually is (and isn't)

LlamaIndex is the **framework** glueing readers → chunkers → embedders → vector stores → retrievers → postprocessors → query engines. It is NOT a model. The current bundle uses:

- `llama-index-core` — the orchestration interfaces.
- `llama-index-vector-stores-postgres` — pgvector adapter.
- `llama-index-embeddings-openai` — calls OpenAI API.
- `llama-index-embeddings-huggingface` — runs sentence-transformers locally (extras-gated).

There is a **`llama-index-embeddings-voyageai`** community package and a **`llama-index-postprocessor-voyageai-rerank`** community package. (Could not confirm exact versions because LlamaIndex's docs are blocked by Zscaler from this machine, but the package family is well-known and follows the same import shape as the OpenAI/HuggingFace ones already wired here.) Both are HTTP wrappers around Voyage's REST API — they don't bring new dep weight comparable to the `huggingface-hub`/`transformers`/`sentence-transformers` chain that the local embedder pulls in. Closer in weight to `llama-index-embeddings-openai`.

Nothing about Voyage AI obviates `llama-index-core`. You still need:
- A reader to ingest customer docs ([`readers.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py)).
- A chunker.
- A vector store (Voyage doesn't host one — they emit vectors and you persist them, today in pgvector).
- A retriever wired to that vector store.
- A query interface ([`__main__.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py) exposes `knowledge_query`).

Voyage replaces *only* the boxed step "turn text into vector" and (newly) "rerank candidates". Everything around it is still LlamaIndex.

---

## Replace? Complement? Hinder?

### Replace LlamaIndex with Voyage AI? No.

Voyage AI does not ship:
- Document readers (PDF, DOCX, Markdown, etc.)
- Chunkers / sentence splitters
- Vector store integrations (no Voyage-hosted vector DB)
- Retrievers / query engines
- Index abstractions
- The pluggable postprocessor pipeline

If we ripped LlamaIndex out, we'd have to write ~all of that ourselves around raw Voyage API calls. That's not a productivity trade we'd make on purpose.

### Complement? Yes — at two specific layers.

**Layer 1: embedder swap (low effort, low novelty).**
Add a `_load_voyage()` branch to [`embedder.py:143`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py#L143) wrapping `llama-index-embeddings-voyageai`. The signature line becomes `voyage:voyage-4` (or whichever model). Add the `(provider, model) → dim` entry to `EMBED_DIMS`. Add `VOYAGE_API_KEY` validation + the same egress-pinning pattern already used for OpenAI (`OPENAI_API_BASE_PINNED` at line 89 — Voyage's equivalent is `https://api.voyageai.com/v1`). Document `EK_EMBEDDER=voyage` in `.env.example`. **This is a ~50-line change** following the OpenAI branch verbatim.

The user-visible win is access to: 32K context, selectable dims, and the domain-tuned variants. Quality lift will vary by corpus. Worth A/B-ing on a representative customer corpus before defaulting anything.

**Layer 2: reranker — the actually-interesting addition.**
Currently there's no reranker. Adding `llama-index-postprocessor-voyageai-rerank` as a node postprocessor means changing [`storage.py:185-186`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L185) from:
```python
retriever = index.as_retriever(similarity_top_k=k)
nodes = retriever.retrieve(query_text)
```
…to retrieve a wider top-K (say 50), then run the reranker postprocessor over them, then truncate to the user-requested k. Behind a separate `EK_RERANKER` env var so customers can opt out. Reranking is *the* highest-leverage retrieval-quality lever in RAG; this is the change worth running an experiment on.

Worth noting: a reranker is the kind of thing that *can* be local (cross-encoder models from HuggingFace work too). Voyage just hosts it as a service. The architectural decision is "do we want a reranker at all?" — Voyage is a question of *which* reranker.

### Hinder? Three caveats.

1. **New egress destination.** `embedder.py` already pins `https://api.openai.com/v1` and refuses overrides ([line 89-120](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py#L89-L120)) — same pattern would apply to `https://api.voyageai.com/v1`, but adopting Voyage means **adding a destination to the customer's allow-list** alongside (or instead of) OpenAI. Customers running egress-restricted deployments will need a security-review cycle before flipping the env var. Not a blocker; not free.

2. **Embedder signature is baked into source metadata.** From [`embedder.py:1-15`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py#L1-L15): switching `EK_EMBEDDER` forces a re-index. Going from `openai:text-embedding-3-small` to `voyage:voyage-4` is not a free swap — every previously-registered source has to be re-embedded. This is by design (mixing embedding spaces is incoherent), but worth being explicit about: Voyage isn't a runtime knob, it's a deploy-time decision per source.

3. **One more vendor relationship.** Single-vendor gravity (everything OpenAI today) has its own tax, but adding a second is a real ops cost: another API key to mint/rotate, another billing relationship, another rate-limit class to monitor, another SOC 2 report to file. The 200M-free-token tier softens dev/eval spend, but production at scale is a procurement conversation. Worth weighing against the quality lift before committing.

---

## Recommendation (one paragraph)

**Treat Voyage AI as an additional provider in `EK_EMBEDDER` (next to `local` / `openai`), and pilot the reranker as a new `EK_RERANKER=voyage` postprocessor stage.** The embedder add is mechanical. The reranker is where the actual retrieval-quality wins live, and it's also the only one of the two that's genuinely *new capability* rather than a cost/quality re-trade against OpenAI. Don't replace LlamaIndex — that framing is a category error; Voyage doesn't compete with it.

---

## Open questions (not investigated)

- How does `voyage-4` actually score vs `text-embedding-3-large` on a representative *customer* corpus? Vendor-published benchmarks aren't trustworthy; needs a local A/B.
- What's the latency profile of `rerank-2.5` at our top-K? Adds an extra hop on every query path.
- Does `voyage-context-3` (chunk + global context aware) materially change how chunking would be designed in [`readers.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py)? Possibly the most architecturally interesting model in the lineup.
- Azure-style "self-host the model in a customer VPC" deployment shape: does Voyage offer this for enterprise tier? If not, OpenAI's Azure deployment posture is still differentiated for compliance-locked customers.
