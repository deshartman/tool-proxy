# Enterprise Knowledge — Full Implementation Plan

> **Status: completed 2026-06-19.** Phases 0 + 1 + 3 shipped on `fix/ek-strapin`. Follow-on admin source-registration UX (`sources.yaml`) tracked separately.

> **Goal.** Replace the in-memory stub in [bundles/enterprise-knowledge/](../../bundles/enterprise-knowledge/) with a real LlamaIndex-backed RAG pipeline that can index **local files** (v1) and (later) Confluence/web/SharePoint/GDrive pages, queried through the existing four MCP tools without any wire-format change.
>
> **Status (2026-06-15).** Phases 0 + 1 + 3 are **done and committed** on branch `fix/ek-strapin`. The Zscaler/HuggingFace blocker was resolved by wiring a **pluggable embedder** with OpenAI as the default lockdown path; HF stays available behind a `[local]` install extra. Phase 3 (`sources_refresh` with chunk-hash diff) shipped. Tunnel reconnect was fixed in the same branch as a separate concern.
>
> **Next.** Admin source-registration UX — see [stateful-shimmying-canyon.md](stateful-shimmying-canyon.md). Adds declarative `sources.yaml` next to the bundle's `.env` so an admin who's been told "hook up a directory, Confluence, and a wiki URL" can do so without driving MCP tools by hand. Wires Confluence + web + SharePoint + Google Drive readers behind install extras.
>
> **Scope locked.** Phases 0 + 1 + 3 are complete. The original Phase 2 (Confluence reader) folds into the next phase via the new `sources.yaml` plan. Workflow rewrap (formerly Phase 4) parked indefinitely.

## Commit log (this implementation)

| Commit | What landed |
|---|---|
| `a459173` | Wire EK bundle to LlamaIndex + pgvector (Phase 1, work-in-progress) |
| `b535746` | Pluggable embedder + OpenAI egress lockdown for EK bundle |
| `55a003a` | Real `sources_refresh` with chunk-hash diff (Phase 3) |
| `5711395` | Updated demo file |
| `ec3a57c` | Make tunnel reconnect survive controller restarts and DB resets (adjacent, on same branch) |
| `726c3a0` | Merge main into `fix/ek-strapin` |

## What's on the branch (2026-06-15)

| File | State |
|---|---|
| [docker-compose.dev.yml](../../docker-compose.dev.yml) | Pgvector sidecar, port **5433** (avoids collision with sibling `agentic_procedure_postgres`). Named volume `mcp-shim_ek-postgres-data`. **Verified up + reachable + auth works.** |
| [migrations/0001_init.sql](../../bundles/enterprise-knowledge/migrations/0001_init.sql) | `pgvector` extension + `ek_sources` metadata table. Idempotent. |
| [migrations/0002_embedder_signature.sql](../../bundles/enterprise-knowledge/migrations/0002_embedder_signature.sql) | Adds `embedder_signature TEXT` to `ek_sources` so query-time can detect dim/provider mismatches. |
| [pyproject.toml](../../bundles/enterprise-knowledge/pyproject.toml) | Default deps: `mcp`, `pydantic`, `llama-index-core`, `llama-index-vector-stores-postgres`, `llama-index-embeddings-openai`, `psycopg[binary]`. **HF deps gated behind `[local]` extra** — keeps `huggingface.co` out of the OpenAI-only deployment's reachable surface. |
| [src/customer_ek_mcp/settings.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/settings.py) | DSN required at boot; embed model dispatched by `embedder.py`. |
| [src/customer_ek_mcp/embedder.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py) | **NEW.** Pluggable embedder factory. `EK_EMBEDDER=local\|openai`. OpenAI path pins `https://api.openai.com/v1`, refuses `OPENAI_BASE_URL`/`OPENAI_API_BASE` overrides, refuses mixed-provider env (Azure vars set when `EK_EMBEDDER=openai`). Returns `LoadedEmbedder(model, signature, embed_dim)`. `azure_openai` documented but raises `NotImplementedError` until wired. |
| [src/customer_ek_mcp/readers.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py) | `pick_reader(url, kind=None)` — local files only today via `SimpleDirectoryReader` (handles `.txt`/`.md`/`.pdf`/`.docx`). Stable doc IDs `file:<file_path>` so refresh diff can `delete(ref_doc_id=...)`. Other kinds raise `NotImplementedError`. |
| [src/customer_ek_mcp/metadata.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/metadata.py) | `record_source_metadata` / `load_source_metadata` / `all_source_metadata` over `psycopg`. Persists `chunk_hashes` (Phase 3) + `embedder_signature`. Per-call connections (low QPS, no pool). |
| [src/customer_ek_mcp/storage.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py) | Module-load: settings → migrations → embedder (binds `LlamaSettings.embed_model`). Real `register_source(url)`, `query(source_id, q, k)`, `refresh(source_id, force=False)`, `list_sources()`. Per-source pgvector table `data_data_<source_id>`. Embedder mismatch on query → clear error pointing at `sources_refresh(force=True)`. |
| [mcp/bundled/enterprise-knowledge/.env.example](../../mcp/bundled/enterprise-knowledge/.env.example) | DSN required; embedder block (`EK_EMBEDDER` + provider-specific keys); Confluence vars present but commented "parked, not yet wired". |

**Verified end-to-end.** OpenAI embedder reaches `api.openai.com` from this laptop. Register a local folder → real semantic chunks come back from `knowledge_query`. `sources_refresh` no-ops on unchanged content; on a single-paragraph edit it re-embeds only the affected `ref_doc_id`.

## Resolved blocker — Zscaler/HuggingFace

The `bge-small` HF download failed under Zscaler TLS interception (Python's `certifi` doesn't trust the corporate intermediate CA). **Resolution: stop relying on HF for the default path.** OpenAI is now the default embedder; the HF path stays available behind the `[local]` extra for customers who can reach `huggingface.co` and want chunk text to stay local. This was always the right architectural answer (customers shouldn't have a 130MB HF model baked into the OCI image they didn't ask for) — the Zscaler block forced the fix earlier rather than later.

## Resolved decisions

| # | Question | Outcome |
|---|---|---|
| 1 | Default embedder for the OCI image | **OpenAI** is the default. HF (`local`) gated behind `[local]` extra. The image ships no HF weights; customers picking `local` install the extra and pay first-boot download cost themselves. |
| 2 | Test target on this laptop | **OpenAI verified** — reaches `api.openai.com` cleanly. |
| 3 | HF deps in default install | **Reversed from earlier lean.** Default deps are OpenAI-only; HF deps live in `[local]` extra. Lockdown discipline beats one-image-fits-all. |
| 4 | `OPENAI_API_KEY` scope | Confirmed isolated per-MCP-child via [CLAUDE.md](../../CLAUDE.md) "Per-entry env precedence". `.env.example` documents this. |
| 5 | Embedder for Phase 3 chunk-diff | Confirmed embedder-agnostic in implementation — text hashes, not vectors. |

## Lockdown posture (the production rule that came with the embedder rewrite)

Customer environments are not "open Internet by default". Egress must be predictable and provider-pinned:

- **OpenAI URL pinned** to `https://api.openai.com/v1` — `embedder.py` refuses `OPENAI_BASE_URL`/`OPENAI_API_BASE` overrides at boot.
- **Mixed-provider env refused** — if `EK_EMBEDDER=openai` and any `AZURE_OPENAI_*` var is set, boot fails fast.
- **Embedder signature persisted** per source — `embedder_signature` column populated at register; `query` rejects mismatch with an actionable error pointing at `sources_refresh(force=True)`.
- **Embed dimension table is hardcoded** in `embedder.py` (`EMBED_DIMS`). pgvector tables are created at `embed_dim` at register time, so the dim must be known *before* the first embed call. Adding a new model means adding a row to that table.
- **HF deps quarantined** behind `[local]` extra — OpenAI-only deployments physically can't reach `huggingface.co` from the bundle.

## Side issues, status

- **HuggingFace dep version churn** — no longer load-bearing for default install. If a customer opts into `[local]`, they pick up whatever the `llama-index-embeddings-huggingface>=0.3` line resolves to today; pin tightening can wait for a real bug report.
- **Type 3 image install loop / HF pre-warm** — moot for default install; not pursued.
- **`embed_dim` hardcoded** — moved to `EMBED_DIMS` table in `embedder.py`, keyed by `(provider, model)`. No longer in `storage.py`.

## Pre-existing content (decisions table, phases) — unchanged below this line

## Out of scope (explicit)

- New MCP tools or schema changes — `sources_register` / `sources_fetch` / `sources_refresh` / `knowledge_query` keep their current shapes ([__main__.py:30-102](../../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py#L30-L102)).
- Controller-side changes. The bundle's contract with the controller is the four tools and their JSON shapes; that doesn't move.
- **Confluence reader. Parked.** Will land later as a `pick_reader()` dispatch case + three `EK_CONFLUENCE_*` env vars; nothing in `storage.py`, `metadata.py`, or the migrations changes when it does.
- SharePoint, Notion, Google Drive readers. Same parking treatment.
- `workflow_as_mcp` rewrap. Tools stay wired through the bare `mcp` SDK in `__main__.py`.

## Decisions to make before coding

These shape the implementation. I have a recommendation for each — push back where you disagree.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Backend (dev + prod) | **pgvector everywhere** | User-confirmed. Single backend simplifies code (no dispatch in `storage.py`) and matches the production deploy. Cost is one `docker compose up` for the sidecar. Chroma path is dropped from this plan. |
| 2 | Embedding model | **`BAAI/bge-small-en-v1.5`** (local HuggingFace) | Already in the README/`.env.example`. ~130MB, runs CPU-only. Keeps chunk text on the laptop — important for the Confluence story (customers won't ship internal docs to OpenAI). |
| 3 | Source-id stability | Keep current `_stable_source_id(url)` (sha1 of URL, 12 chars) | Already in [storage.py:43](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L43). Idempotent re-register. Good enough; rev later if collisions matter. |
| 4 | Local-files reader | **`SimpleDirectoryReader`** from llama-index-core | Built-in, handles `.txt` / `.md` / `.pdf` / `.docx` out of the box via the readers it ships with. |
| 5 | Refresh strategy | **Content-hash diff per chunk** | `sources_refresh` re-fetches, re-chunks, hashes each chunk, only re-embeds the ones whose hash changed. Matches what the docstring already promises ([__main__.py:73-92](../../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py#L73-L92)). |

★ Insight ─────────────────────────────────────
- The bundle is already structured for this drop-in: [readers.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py), [metadata.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/metadata.py), and [workflows/](../../bundles/enterprise-knowledge/src/customer_ek_mcp/workflows/) are deliberately empty placeholders with import paths the plan files assume. We're filling in skeletons, not redesigning.
- The four tools' wire shape is the contract with the controller. Anything that changes a tool's input schema or return JSON is a breaking change for procedures that already reference EK; anything below `storage.py` is free to evolve.
- Type 3 isolation means we can pull in `llama-index` + `chromadb` + `psycopg` without touching the Node connector's dependency tree — the bundle's venv is sealed.
─────────────────────────────────────────────────

## Phased plan

The phases are sequenced so each one is independently demoable. Stop at any phase and you have a working laptop story for that scope.

### Phase 0 — Postgres + pgvector sidecar

**Outcome.** A local Postgres reachable from the connector, with the `pgvector` extension installed and ready. No bundle code changes yet — just infrastructure.

Work:

1. **Add a `docker-compose.dev.yml` at the repo root** based on the snippet in [bundles/enterprise-knowledge/README.md:73-99](../../bundles/enterprise-knowledge/README.md#L73-L99). Service: `pgvector/pgvector:pg16`, db `enterprise_knowledge`, user `ek`, port published to `5432` on the host so the connector running outside Docker (the dev path today) can reach it.
2. **Document a `make ek-db-up` / `down` / `psql` shortcut** in the repo README or [scripts/](../../scripts/) so the customer doesn't memorize compose commands.
3. **Land migrations** in [migrations/0001_init.sql](../../bundles/enterprise-knowledge/migrations/) — creates the `pgvector` extension and the `ek_sources` metadata table:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE TABLE IF NOT EXISTS ek_sources (
     source_id     TEXT PRIMARY KEY,
     url           TEXT NOT NULL,
     kind          TEXT NOT NULL,
     indexed_at    TIMESTAMPTZ NOT NULL,
     doc_count     INTEGER NOT NULL,
     chunk_hashes  JSONB NOT NULL DEFAULT '[]'::jsonb
   );
   ```
4. **Apply migrations on startup** when `EK_VECTOR_STORE=pgvector` (idempotent — the `IF NOT EXISTS` guards handle re-runs).

**Verification.** `docker compose -f docker-compose.dev.yml up -d` brings Postgres up. `psql ${EK_PGVECTOR_DSN}` connects. Connector boot doesn't error.

### Phase 1 — Real backend, local files only, pgvector

**Outcome.** `sources_register` against a `file://` URL or local path actually fetches, chunks, embeds, and persists into Postgres. `knowledge_query` returns real semantic-search results. No Confluence yet.

Work:

1. **Promote llamaindex extra to default deps** — move the `[project.optional-dependencies].llamaindex` block in [pyproject.toml:19-30](../../bundles/enterprise-knowledge/pyproject.toml#L19-L30) up into `dependencies`. Drop `llama-index-vector-stores-chroma` and `chromadb` (we're not using Chroma).
2. **Simplify [`settings.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/settings.py)** — drop the `chroma` and `stub` literal options from `VectorStoreBackend`. `pgvector` is the only backend; `EK_PGVECTOR_DSN` becomes required at boot.
3. **Implement [`readers.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/readers.py)** — single function `pick_reader(url, kind=None) -> list[Document]`. Dispatch:
   - `file://` URL or absolute path → `SimpleDirectoryReader`.
   - Anything else → raise `NotImplementedError("source kind not yet supported")` (Confluence lands in phase 2).
4. **Replace [`storage.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py)**. Drop `_StubStore`. New module exposes the same four public functions (`register_source`, `query`, `refresh`, `list_sources`) backed by:
   - `PGVectorStore` keyed off `EK_PGVECTOR_DSN`, **one table per `source_id`** (LlamaIndex's default model — table name = `data_<source_id>`).
   - LlamaIndex `VectorStoreIndex.from_documents(...)` for register.
   - `index.as_retriever(similarity_top_k=k).retrieve(query)` for query.
   - Source metadata via [`metadata.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/metadata.py) (writes to the `ek_sources` table from phase 0). Same Postgres, same connection — one backup target, transactional consistency, as the README promises.
5. **Implement [`metadata.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/metadata.py)** — three functions: `record_source_metadata`, `load_source_metadata`, `all_source_metadata`. Uses `psycopg` against the same DSN.
6. **Wire embedder** — at module load, set `llama_index.core.Settings.embed_model = HuggingFaceEmbedding(model_name=os.environ.get("EK_EMBED_MODEL", "BAAI/bge-small-en-v1.5"))`. Cache the model in `~/.cache/huggingface/` (default).
7. **Update `.env.example`** — flip `EK_VECTOR_STORE=pgvector` to live (it already is, just clean up the Chroma comments). Make `EK_PGVECTOR_DSN` the prominent line.

**Verification.** Postgres up from phase 0. Boot the connector, call `sources_register` with `file:///path/to/some-folder`, then `knowledge_query` with a question whose answer is in those files. Real semantic results, not `[stub chunk N]`. Confirm rows in `psql -c "SELECT source_id, url, doc_count FROM ek_sources;"`.

### Phase 2 (parked) — Confluence Cloud reader

Not part of this implementation pass. When it lands later, the work is local to:
- `pick_reader()` in `readers.py` — one new dispatch branch.
- `.env.example` and the bundle README — three new `EK_CONFLUENCE_*` vars + setup notes (API token + email, Basic auth, mint at <https://id.atlassian.com/manage-profile/security/api-tokens>; works under Okta SSO).
- `pyproject.toml` deps — add `llama-index-readers-confluence`, `atlassian-python-api`.

Nothing in `storage.py`, `metadata.py`, the migrations, or the MCP tool surface needs to change.

### Phase 3 — Real `sources_refresh`

**Outcome.** Re-running `sources_refresh` on an indexed source detects which chunks changed and only re-embeds those. Embedder calls drop ~95% on small edits.

Work:

1. Stash `chunk_hashes` (sha256 of normalized chunk text) in the `ek_sources.chunk_hashes` JSONB column during register.
2. `refresh(source_id, force)`:
   - Re-fetch via `pick_reader(source.url, source.kind)`.
   - Re-chunk through the same node parser.
   - Compare new chunk hashes to stored.
   - Delete + re-add only the deltas in the source's `data_<source_id>` table.
   - Update the `ek_sources` row.
3. With `force=True`, drop the `data_<source_id>` table and re-index from scratch.

**Verification.** Register a local file, edit one paragraph, call `sources_refresh`, watch logs show "1 of N chunks changed". Query reflects the edit.

### Phase 4 (optional) — Workflow rewrap

**Outcome.** Each tool becomes a LlamaIndex `Workflow` class wrapped via `workflow_as_mcp`, populating [workflows/](../../bundles/enterprise-knowledge/src/customer_ek_mcp/workflows/). No behavior change; this is purely structural to match the eventual LLAMA-INDEX.md design.

Skip unless you actively want it. The current bare-`mcp`-SDK shape in `__main__.py` is fine.

## Risk register

| Risk | Mitigation |
|---|---|
| `bge-small-en-v1.5` first-run pulls ~130MB — connector startup blocks | Pre-warm at image build time during the Dockerfile bundle stage. Local dev: one-shot first launch is acceptable; document it in the README. |
| LlamaIndex version churn breaks the bundle | Pin to compatible-release versions in `pyproject.toml` (`llama-index-core>=0.11,<0.13`). Refresh the lock when intentional. |
| Confluence PAT in `.env` leaks via process listing | Already mitigated — env is per-MCP-child only and never leaves the bundle's process. Document in README that `mcp/bundled/enterprise-knowledge/.env` is gitignored and treated as a secret. |
| `sources_refresh` running concurrently with `knowledge_query` against the same `source_id` | Hold the existing `Lock` in `storage.py` around refresh writes. Reads can race; results may be from old or new chunks during a refresh — acceptable, document it. |
| Postgres sidecar not running when connector boots | Connector boot connects lazily — Postgres only matters when an EK tool is invoked. First tool call returns a clear error. Document in README that `docker compose up` is a prerequisite. |

## Locked scope

Phases 0 → 1 → 3 are **complete**. Local files via `SimpleDirectoryReader`. Pluggable embedder (OpenAI default, HF behind `[local]` extra). Real `sources_refresh` with chunk-hash diff.

## Next phase — products registry + sources.yaml + GDrive reader (2026-06-17)

**Locked scope.** Three pieces. Confluence / web / SharePoint stay parked until there's a concrete ask.

1. **Products registry** — `bundles/enterprise-knowledge/src/customer_ek_mcp/products.py`. Single source of truth: each product is one `Product` dataclass entry (id, register-tool name, extra name, env prefix, URL match predicate, loader). Five things keyed off five strings drift; one declaration per product doesn't.
2. **Per-product registration tools, generic query/refresh/fetch.** Today's `sources_register` splits into `<id>_register` tools (one per product). `knowledge_query`, `sources_refresh`, `sources_fetch` stay generic, source-id-keyed. After this phase: `local_register`, `gdrive_register`, `knowledge_query`, `sources_refresh`, `sources_fetch` (5 tools). Tool count grows by one per new product, not four.
3. **`mcp/bundled/enterprise-knowledge/sources.yaml`** — declarative source list, read at boot, auto-registered via the existing idempotent `register_source(url)`. URL is enough to dispatch the right product (registry's `url_match` predicates own that decision); no `kind:` field needed in YAML.
4. **GDrive reader behind `[gdrive]` extra** — `llama-index-readers-google`. Two auth postures, env-dispatched: `EK_GDRIVE_AUTH=service_account|oauth_user`. Same lockdown shape as [embedder.py](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py): refuse boot if required env is missing, refuse mixed-mode env. URL form in `sources.yaml` is the full `https://drive.google.com/drive/folders/<id>`.

### Tool surface — final shape

| Tool | Per-product? | Why |
|---|---|---|
| `<id>_register` (e.g. `gdrive_register`, `local_register`) | Yes | Auth modes, URL shapes, validation differ per product |
| `knowledge_query(source_id, query, k)` | No | Source-id-keyed; chunks are chunks. Procedure asking "what's our refund policy?" shouldn't need to know which product holds it. |
| `sources_refresh(source_id, force)` | No | Source-id-keyed; reader looked up via the stored `kind` (= product id) |
| `sources_fetch()` | No | Returns all sources with `kind`, `status`, `last_error`, `last_attempted_at`. Controller filters client-side for per-product UI grouping. |

The argument for keeping query generic: splitting `gdrive_query` vs `confluence_query` would force a procedure author to know *where* the answer lives before asking — which defeats RAG existing as a primitive in the first place.

### Resolved decisions

| # | Question | Outcome |
|---|---|---|
| 1 | Dispatch shape | **Products registry table** in [`products.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/products.py). Hardcoded list, not plugin discovery — five products won't justify entry-points machinery. |
| 2 | Registration shape | **Per-product `<id>_register` tools.** Auto-derived from the registry; never authored by hand. |
| 3 | Query/refresh/fetch shape | **Stay generic, source-id-keyed.** Source-id is opaque; product info available via `sources_fetch`'s `kind` field. |
| 4 | GDrive auth | **Both `service_account` and `oauth_user`, env-dispatched** via `EK_GDRIVE_AUTH`. Mirrors `EK_EMBEDDER` precedent. |
| 5 | GDrive URL form | **Full URL** `https://drive.google.com/drive/folders/<id>`. Registry's `url_match` predicate owns parsing. |
| 6 | sources.yaml location | `mcp/bundled/enterprise-knowledge/sources.yaml`. Customer-owned, gitignored. A `sources.yaml.example` ships in the repo. |
| 7 | Boot-time fetch errors | **Option C — hybrid.** Auth/config errors fail fast (matches embedder.py); per-source fetch errors skip-and-warn AND persist a `status='failed'` row in `ek_sources` so `sources_fetch` surfaces them to the Controller. |
| 8 | Interactive `<id>_register` errors | **Raise to caller.** The MCP tool error response IS the surfacing path. Don't double-report. |
| 9 | Refresh-time failures | **Update `last_error`, leave previous chunks intact.** Operators see staleness; queries don't suddenly break. |
| 10 | Plan-doc home | **Update this file in place.** One EK source of truth. |

### File-layout split

`readers.py` becomes a package so each product's loader has somewhere to live:

```
src/customer_ek_mcp/
  products.py              # registry: PRODUCTS list, PRODUCT_BY_ID, lookup helpers
  source_loader.py         # parses sources.yaml, drives boot-time auto-register
  readers/
    __init__.py            # re-exports pick_reader() — consults the registry
    local.py               # _load_local() + url_match (file:// or absolute path)
    gdrive.py              # _load_gdrive() + url_match + EK_GDRIVE_* env handling
```

### Migration — `ek_sources` schema add

Phase 4a needs one migration: `0003_source_status.sql`. Adds:
- `status TEXT NOT NULL DEFAULT 'indexed'` — `indexed` | `failed`
- `last_error TEXT` — populated when boot or refresh fails
- `last_attempted_at TIMESTAMPTZ` — useful for the Controller's UI

Idempotent (`ADD COLUMN IF NOT EXISTS`). No data migration; existing rows default to `indexed` which is what they were.

### Phased work

**Phase 4a — registry + tool split + sources.yaml + status column (no GDrive yet).**

1. **Migration** — `migrations/0003_source_status.sql` adds the three columns.
2. **`products.py`** — `Product` dataclass, `PRODUCTS = [LOCAL_PRODUCT]`, `PRODUCT_BY_ID`, `pick_product(url)` helper.
3. **`readers/` package** — split today's flat `readers.py`. `readers/local.py` carries the local-files loader unchanged; `readers/__init__.py` re-exports `pick_reader()` which consults the registry.
4. **`storage.py`** — `register_source(url)` records a `status='failed'` row on exception (re-raise after persisting). New helper `_record_failed_source(source_id, url, kind, error)`. `refresh()` updates `last_error` on exception, leaves chunks intact (re-raise after persisting). `query()` rejects sources with `status='failed'` and no chunks; allows `status='failed' but has chunks` (refresh-failure case) with a soft warning in the response.
5. **`metadata.py`** — extend `SourceMetadata` with `status`, `last_error`, `last_attempted_at`. `record_source_metadata()` writes them; `load_source_metadata()` and `all_source_metadata()` return them. `sources_fetch` echoes them in the JSON response.
6. **`source_loader.py`** — `load_sources_yaml(path) -> list[SourceSpec]`. Pydantic schema: `sources: [{url: str, refresh_hint?: str}]`. `bootstrap_sources()` iterates and calls `storage.register_source(url)` for each, catching per-source exceptions (option C). Path resolution: `EK_SOURCES_YAML` env var (set by the bundle's `.env`), or `<bundle .env dir>/sources.yaml` if unset.
7. **`__main__.py`** — tool list computed from registry: one `<id>_register` per product + the three generics. Dispatch in `_call_tool()` looks up the product by `name.removesuffix('_register')`. Bootstrap runs once before `stdio_server()` opens.
8. **`mcp/bundled/enterprise-knowledge/sources.yaml.example`** — ships committed; real `sources.yaml` gitignored.

**Verification (4a).**
- Existing local-files registration via `local_register` works identically to today's `sources_register`.
- Drop a `sources.yaml` listing a `file://` URL. Boot the connector. `psql` shows the row indexed.
- Drop a `sources.yaml` listing a non-existent path. Boot. Bundle comes up; `sources_fetch` returns the failed row with `status='failed'` and `last_error` populated.
- `sources_register` (the old name) is removed; controller-side is updated to call `local_register`. Wire-shape change is intentional and load-bearing for the per-product split.

**Phase 4b — GDrive product.**

1. **Extra** — `[project.optional-dependencies].gdrive = ["llama-index-readers-google>=0.4"]`. Customers run `uv pip install -e .[gdrive]`.
2. **`readers/gdrive.py`** — `_load_gdrive(url, kind=None) -> tuple[list[Document], str]`. Imports `GoogleDriveReader` lazily (clear `ImportError` → "install with `[gdrive]` extra"). Reads `EK_GDRIVE_AUTH` (default: `service_account`). Same lockdown discipline as the embedder: required env vars enforced, mixed-mode env refused.
3. **Stable doc IDs** — `gdrive:<file_id>` so refresh diff works.
4. **Registry** — append `GDRIVE_PRODUCT` to `PRODUCTS`. Tool list grows to 5 (`local_register`, `gdrive_register`, `knowledge_query`, `sources_refresh`, `sources_fetch`).
5. **`mcp/bundled/enterprise-knowledge/.env.example`** — add `EK_GDRIVE_*` block, structured the same way as the embedder block.

**Verification (4b).**
- `EK_GDRIVE_AUTH=oauth_user` with valid client config + token paths → boot succeeds.
- `EK_GDRIVE_AUTH=service_account` with no key path → boot fails fast with actionable error.
- Both modes set → boot fails (mixed-mode lockdown).
- `gdrive_register` against a Drive folder URL → returns `source_id`; `psql` shows row with `kind='gdrive'`.
- `knowledge_query` against the GDrive `source_id` returns chunks.
- Edit one Drive doc, call `sources_refresh`, logs show `1 of N chunks changed`.

### Ownership note

This plan file is the single source of truth for EK. Update in place when scope or decisions change.
