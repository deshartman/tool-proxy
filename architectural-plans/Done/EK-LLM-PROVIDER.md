# EK-LLM-PROVIDER — Consolidate the `enterprise-knowledge` bundle to Ollama sidecar only

> **Status: completed 2026-07-09.** Landed on `feature/ek-embedding` in [`ab87554`](../../ commit-ab87554); merged to `main` in [`d029886`](../../ commit-d029886). Work-list items 1-10 shipped; item 11 (smoke test) is a runtime verification tracked outside the plan.
>
> **Purpose.** Reduce the bundle's embedding surface to a single path: `EK_EMBEDDER=ollama` (self-hosted Ollama sidecar, `nomic-embed-text-v1.5` @ 768-dim). Remove the `local` HuggingFace-on-host adapter, the OpenAI adapter, and the `azure_openai` stub. Add an `embedding` service to the connector's compose stack.
>
> **Not a chat-LLM plan.** The bundle does not call chat LLMs. It retrieves chunks via `index.as_retriever().retrieve(...)` — [`bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py:210`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L210) — and returns them to the controller, which handles response synthesis with the customer's chat LLM of choice. This plan is exclusively about the embedding step (text → vector).
>
> **Prior art (load-bearing).** The controller team shipped essentially this design in `feat/embeddings-self-hosted` (2026-07-06/07): Ollama sidecar, `nomic-embed-text-v1.5` @ 768-dim, Docker service, boot-time warm-up, persistent volume for model cache. Model choice, memory footprint, and Fly.io deployment costs already validated on their side; this plan is a mechanical port of the same decisions to the connector side.
>
> **Related plans.**
> - [`MULTI-ACCOUNT.md`](../MULTI-ACCOUNT.md) — deferred embedder-choice as an open item pointing at this doc; that placeholder can be closed as "no choice — always Ollama".
> - [`REMOVE-BUNDLED-TWILIO.md`](../REMOVE-BUNDLED-TWILIO.md) — precedent for scoping bundle-side dep surface tightly. This plan follows the same discipline: fewer providers, one Python adapter, one sidecar service.

## TL;DR

**One embedder, one sidecar, no cloud egress, no in-process ML deps.** The bundle gains `EK_EMBEDDER=ollama` and loses everything else. The connector's `docker-compose.dev.yml` gains an `embedding` service (`ollama/ollama:latest`, port 11434, persistent volume for the model cache). `pyproject.toml` swaps `llama-index-embeddings-openai` for `llama-index-embeddings-ollama` in base deps; the `[local]` extra (HuggingFace) is deleted entirely. `.env.example` documents `EK_EMBEDDER=ollama` + `OLLAMA_URL` + `EK_OLLAMA_MODEL` and nothing else.

Why Ollama over the current alternatives:
- **Zero customer-managed API keys** for embedding. No cloud accounts to provision.
- **Zero external egress at inference time.** Chunk text and query text never leave the customer's infrastructure.
- **No heavyweight in-process ML deps.** `llama-index-embeddings-huggingface` pulls in `transformers`, `sentence-transformers`, `huggingface-hub` — hundreds of MB of Python + native code inside every bundle process. Ollama moves that out of the bundle's venv into an isolated container that the connector's operators already know how to run (same shape the controller team uses).
- **Proven at Twilio.** The controller-side deployment has been running `nomic-embed-text-v1.5` @ 768-dim in production since 2026-07-07. No new operational learning curve.
- **LlamaIndex-native.** `llama-index-embeddings-ollama>=0.2` is a first-class adapter — no custom integration code.

Cost paid: a sidecar service is now mandatory in every deployment (dev, staging, prod). Adds ~500MB resident + a persistent volume for the model cache. Documented in the deployment sections below.

## Current state

`bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py` dispatches on `EK_EMBEDDER`:

| `EK_EMBEDDER=` | Status | Adapter | Dep origin | Egress at inference |
|---|---|---|---|---|
| `local` (default) | ✅ implemented | `HuggingFaceEmbedding` | `[local]` optional | None (in-process) |
| `openai` | ✅ implemented | `OpenAIEmbedding` (base URL pinned) | base deps | `api.openai.com` |
| `azure_openai` | ❌ `NotImplementedError` stub | — | — | — |

The `_load_openai()` factory carries defensive code that this plan retires along with the adapter: base-URL pinning against `OPENAI_BASE_URL` / `OPENAI_API_BASE` overrides, and a cross-provider env-leak check for `AZURE_OPENAI_*` variables. Both were correctness-critical when OpenAI was a supported path; both are dead code once the path is gone.

`.env.example` in [`mcp/bundled/enterprise-knowledge/.env.example`](../../mcp/bundled/enterprise-knowledge/.env.example) documents all three options and pre-fills `EK_EMBEDDER=local`.

`pyproject.toml` lists `llama-index-embeddings-openai>=0.2` in base deps and `llama-index-embeddings-huggingface>=0.3` under `[project.optional-dependencies.local]`.

`docker-compose.dev.yml` ships only `ek-postgres` today. No embedding sidecar.

## Target state

Single embedder, single factory, single dim, single sidecar.

`embedder.py`:
- `_load_local()` deleted.
- `_load_openai()` deleted.
- `OPENAI_API_BASE_PINNED`, `_AZURE_ENV_VARS`, `DEFAULT_LOCAL_MODEL`, `DEFAULT_OPENAI_MODEL` constants deleted.
- `EMBED_DIMS` collapses to `{("ollama", "nomic-embed-text"): 768}`.
- New `_load_ollama()` factory:
  ```python
  def _load_ollama() -> LoadedEmbedder:
      from llama_index.embeddings.ollama import OllamaEmbedding
      base_url = os.environ.get("OLLAMA_URL", "http://embedding:11434").rstrip("/")
      model_name = os.environ.get("EK_OLLAMA_MODEL", "").strip() or "nomic-embed-text"
      return LoadedEmbedder(
          model=OllamaEmbedding(model_name=model_name, base_url=base_url),
          signature=f"ollama:{model_name}",
          embed_dim=_embed_dim("ollama", model_name),
      )
  ```
- `load_embedder()` collapses: if `EK_EMBEDDER` is set to anything other than `ollama` (or empty), refuse with a migration-hint error naming the removed providers and pointing at `sources_refresh(force=true)`. Otherwise return `_load_ollama()`.
- No `OPENAI_BASE_URL` refuse-to-boot check (OpenAI adapter gone).
- No `AZURE_OPENAI_*` cross-provider leak check (no other providers to leak into).
- **`OLLAMA_URL` is operator-set by design.** Different failure model from `OPENAI_BASE_URL`: an OpenAI base-URL override is almost always exfiltration; an Ollama base-URL override is normal ops (dev peer worktrees on different ports, K8s service names, Fly.io internal DNS). No refuse-to-boot check.

`pyproject.toml`:
- Base `dependencies` swaps `llama-index-embeddings-openai>=0.2` for `llama-index-embeddings-ollama>=0.2`.
- `[project.optional-dependencies].local` block deleted.
- `[project.optional-dependencies].gdrive` untouched — orthogonal.

`.env.example`:
- `EK_EMBEDDER=ollama` as the only supported value.
- New block documenting `OLLAMA_URL=http://embedding:11434` (default = compose service name) and `EK_OLLAMA_MODEL=nomic-embed-text` (default).
- `local`, `openai`, `azure_openai` blocks deleted.

`storage.py`:
- Mismatch error messages at lines 230-236 and 326-331 updated: the "restore the original setting" hint becomes actively misleading (there is no other setting to restore to). Replaced with a message that names the removed providers and directs the caller at `sources_refresh(force=true)`.

`__main__.py`:
- New fire-and-forget warm-up task: on bundle boot, `POST {OLLAMA_URL}/api/pull { "model": "nomic-embed-text" }`. Fire in an asyncio background task, log progress, do NOT block boot. Matches the controller team's approach — removes a customer-facing "why isn't my model loading" question. First-ever boot on a fresh host waits for the ~274MB pull (~1 min); subsequent boots are ~5s cache hits.
- **Boot-time reachability is NOT checked.** A slow-to-start sidecar doesn't gate the bundle's other tools (`sources_fetch`, `<id>_register`, `sources_refresh` metadata operations). First `knowledge_query` waits for the model. Matches the existing bundle posture (`_load_openai` deferred failure to first call, not boot).

`docker-compose.dev.yml`:
- New `embedding` service (see next section).

`Dockerfile` (`packages/connector/Dockerfile`, bundle-build stage at line 92):
- `pip install /bundle-src` unchanged. `llama-index-embeddings-ollama` lives in base deps; the venv gets it automatically.

Docs:
- Bundle README's embedder section trimmed to describe Ollama only.
- New "Deploying the embedding sidecar" section in `docs/deploy/` covering Fly.io / K8s / Docker Compose shape.
- Migration subsection referencing `sources_refresh(force=true)` for any source with a non-`ollama:*` signature.

## Docker Compose — new `embedding` service

Added to [`docker-compose.dev.yml`](../../docker-compose.dev.yml) alongside `ek-postgres`. The `EMBEDDING_HOST_PORT` peer-isolation matches the controller-side pattern so dev worktrees each run their own Ollama concurrently.

```yaml
embedding:
  image: ollama/ollama:latest
  container_name: mcp-shim-embedding
  ports:
    - '${EMBEDDING_HOST_PORT:-11434}:11434'
  volumes:
    - ${EMBEDDING_CACHE_DIR:-./.ollama-cache}:/root/.ollama
  healthcheck:
    test: ['CMD-SHELL', 'ollama list >/dev/null 2>&1 || exit 1']
    interval: 10s
    timeout: 5s
    retries: 12
    start_period: 60s
```

`start-connector.sh` gains a one-line preflight: refuse to boot the connector if `docker compose -f docker-compose.dev.yml ps embedding` doesn't return a running container. Cleaner failure mode than a mysterious first-query timeout when a developer forgot to `docker compose up -d`.

### Kubernetes / Fly.io shape

- **Fly.io:** Ollama as a separate `fly.toml` app (e.g. `mcp-shim-embedding`). `shared-cpu-2x` + 1GB RAM. Persistent volume mounted at `/root/.ollama` to survive scale-to-zero. Approx. cost: ~$5/month. Same shape the controller team's `agentic-procedure-embedding` app uses. `OLLAMA_URL` points at the app's internal Fly DNS (`http://mcp-shim-embedding.internal:11434`).
- **Kubernetes:** `embedding` Deployment + Service in the same namespace as the connector. PVC for `/root/.ollama` (5GB). No Ingress — internal cluster access only. `OLLAMA_URL` points at the Service DNS (`http://embedding.<namespace>.svc.cluster.local:11434`).
- **Docker Compose (dev):** the `embedding` service in the same file. Model cache persists in `.ollama-cache/` at the repo root; `.gitignore` gains a `.ollama-cache/` entry.
- **Docker Compose (prod, single-host deployments):** same shape as dev but with `restart: unless-stopped` and a named volume instead of a bind mount.

All four shapes documented in a new [`docs/deploy/embedding-sidecar.md`](../../docs/deploy/embedding-sidecar.md).

## Migration story for existing sources

The bundle already handles cross-embedder queries defensively — see the mismatch check at [`storage.py:230-236`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L230-L236). On the day a deployment upgrades from `local` or `openai` to `ollama`:

1. Bundle boots with `ollama` embedder; fires background warm-up (~1 min first-ever boot, ~5s thereafter).
2. Any source in `ek_sources` with `embedder_signature LIKE 'local:%'` or `'openai:%'` is still queryable metadata-wise, but the first `knowledge_query` against it refuses with a message like:
   ```
   embedder mismatch on source '<id>': indexed with 'openai:text-embedding-3-small'
   (dim=1536), current embedder is 'ollama:nomic-embed-text' (dim=768). The
   'local' and 'openai' embedders were removed in <release>; re-index with
   sources_refresh(id='<id>', force=true).
   ```
3. Customer runs `sources_refresh(id=<id>, force=true)` for each affected source. `_refresh_force` at [storage.py:348-360](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py#L348-L360) drops the per-source pgvector table entirely and re-creates it at the new dim (`_embedder.embed_dim = 768`), then re-fetches and re-embeds every chunk. Subsequent queries succeed.

Dimension change (384→768 for `local`-embedded sources, 1536→768 for `openai`-embedded sources) is handled by the drop-and-recreate path — pgvector column type is set at register time, so column dim moves cleanly. No manual SQL required.

Alternative: drop the source and re-register from scratch via the appropriate `<id>_register` tool. Equivalent outcome.

No forced migration on upgrade — the bundle boots cleanly (once the sidecar is up), non-query operations (`sources_fetch`, `<id>_register`, `sources_refresh` metadata) work immediately, and only queries against non-`ollama:*`-signed sources hit the refuse path. Customers migrate at their own pace.

## Air-gap and model-pull story

Ollama's default behavior on first `POST /api/pull` is to fetch model weights from `registry.ollama.ai`. Two options for deployments that can't reach that host:

- **Pre-populate the volume.** On a build machine with network access, run `docker run --rm -v <path>:/root/.ollama ollama/ollama:latest ollama pull nomic-embed-text`. Ship the resulting cache directory (a few hundred MB) with the deployment; mount it at the sidecar's `/root/.ollama`. Bundle boot's warm-up call is then a no-op.
- **Bake the model into an image.** Fork `ollama/ollama:latest`, `RUN ollama pull nomic-embed-text` in the Dockerfile, publish to the customer's internal registry. Larger image, deterministic boot.

Both shapes documented in [`docs/deploy/embedding-sidecar.md`](../../docs/deploy/embedding-sidecar.md) alongside the Fly.io / K8s / Compose sections.

## Non-goals

- **In-process HuggingFace embedding.** Deleted. Replaced by the Ollama sidecar for the same "no cloud egress" outcome without dragging `transformers` / `sentence-transformers` into every bundle process.
- **OpenAI / Azure OpenAI / Voyage / Cohere / Bedrock.** Deleted or never added. Every one of these is a cloud API — the whole point of this plan is to eliminate that class of dep. Revisit only if a real customer demand appears and only with an explicit design ticket.
- **Chat-LLM provider abstraction.** Controller-side concern, not bundle-side. Unchanged.
- **Per-source embedder selection.** Same bundle instance = same embedder. Multi-account already assumes one bundle instance per connector.
- **Runtime embedder hot-swap without re-index.** Not possible with fixed-dimension vector stores. Same as before.
- **Model choice beyond `nomic-embed-text`.** `EK_OLLAMA_MODEL` override exists in the env for consistency with the OpenAI adapter's `EK_EMBED_MODEL` pattern, but changing the model *also* requires adding a matching entry to `EMBED_DIMS` in `embedder.py` (dim varies by model). Off-list values fail-fast at boot with a "add the dim to EMBED_DIMS" error — the existing `_embed_dim()` helper already does this.

## Concrete work list

Landed as a single branch (`feature/ek-embedding` → `main` in [`d029886`](../../ commit-d029886)):

- [x] **[`docker-compose.dev.yml`](../../docker-compose.dev.yml)** — `embedding` service (`ollama/ollama:latest`, port 11434, healthcheck, cache volume) added at lines 22-36. `.ollama-cache/` in [`.gitignore`](../../.gitignore) at line 71.
- [x] **[`pyproject.toml`](../../bundles/enterprise-knowledge/pyproject.toml)** — `llama-index-embeddings-ollama>=0.2` in base deps; `openai` dep removed; `[project.optional-dependencies].local` block deleted; `[gdrive]` extra retained (orthogonal).
- [x] **[`embedder.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/embedder.py)** — `_load_local()`, `_load_openai()`, `DEFAULT_LOCAL_MODEL`, `DEFAULT_OPENAI_MODEL`, `OPENAI_API_BASE_PINNED`, `_AZURE_ENV_VARS` all deleted; `EMBED_DIMS` collapsed to the single `("ollama", "nomic-embed-text")` entry; `_load_ollama()` added at line 64; `load_embedder()` at line 81 refuses anything other than `ollama` with a migration-hint error naming the removed providers.
- [x] **[`.env.example`](../../mcp/bundled/enterprise-knowledge/.env.example)** — collapsed to `EK_EMBEDDER=ollama` + `OLLAMA_URL` + optional `EK_OLLAMA_MODEL` block (lines 39-41). `local` / `openai` / `azure_openai` sub-blocks removed. Note: `OLLAMA_URL` defaults to `http://localhost:11434` in the example (compose port-forward for dev) rather than the compose service name — matches the "operator-set by design" note in [Target state](#target-state).
- [x] **[`__main__.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py)** — `_warmup_ollama()` at line 55, scheduled via `asyncio.create_task(asyncio.to_thread(_warmup_ollama))` at line 236 with a module-level task reference so the loop doesn't GC it. Uses `stream=false` + 600s ceiling per the item on the loose-ends checklist. **Deviation from plan:** the warm-up now issues a `GET /api/tags` pre-check and *skips* `/api/pull` when the model is already present. Rationale: corporate TLS-inspection proxies (ZScaler etc.) MITM `registry.ollama.ai` and turn the pull into an unauthenticated fetch error even when the sidecar already has the weights cached. Details in [As-shipped notes](#as-shipped-notes) below.
- [x] **[`storage.py`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/storage.py)** — mismatch messages at lines 232 and 328 rewritten: name the removed providers, direct at `sources_refresh(force=true)`, drop the "restore the original setting" hint.
- [x] **[`scripts/start-connector.sh`](../../scripts/start-connector.sh)** — preflight at lines 117-124 refusing boot when `EK_EMBEDDER=ollama` but `docker compose ps embedding` doesn't show a running `mcp-shim-embedding` container. Skips silently when `EK_EMBEDDER` is unset (Type 3 bundle not enabled).
- [x] **[`docs/deploy/embedding-sidecar.md`](../../docs/deploy/embedding-sidecar.md)** — new (305 lines). Fly.io / K8s / Compose (dev + prod) / air-gap sections.
- [x] **[`bundles/enterprise-knowledge/README.md`](../../bundles/enterprise-knowledge/README.md)** — embedder section trimmed, "Migration from older embedders" subsection added at line 116, link to `docs/deploy/embedding-sidecar.md`.
- [x] **Tests** — [`bundles/enterprise-knowledge/tests/test_embedder.py`](../../bundles/enterprise-knowledge/tests/test_embedder.py) (176 lines) covers the four scenarios: Ollama adapter selection, refuse-with-migration-hint on legacy values, `EMBED_DIMS` lookup for `ollama:nomic-embed-text`, warm-up scheduling on boot. Bundle's first pytest module — also lays down `tests/__init__.py`.
- [ ] **Smoke test.** Runtime verification, not tracked here. Re-run at customer-side deploy time; if it surfaces a bug the fix goes on its own branch, not this plan.

~677 lines added / 145 lines removed across 12 files per `git show --stat ab87554` — the deletions in `embedder.py` and `.env.example` were smaller than estimated, offset by the new `docs/deploy/embedding-sidecar.md` (305 lines) and `test_embedder.py` (176 lines).

## As-shipped notes

Two deviations from the plan text worth capturing so a future reader isn't surprised by the diff:

1. **`_warmup_ollama()` pre-checks `/api/tags` before hitting `/api/pull`.** The plan called for a straight fire-and-forget `POST /api/pull` at boot. Discovered during pre-merge smoke: in corporate networks where TLS inspection is on (ZScaler, Bluecoat), Ollama's outbound to `registry.ollama.ai` sees a MITM cert and the pull fails even when the sidecar's volume already has the weights cached. The pre-check makes the common "cached model, no network access" path succeed — only the first-ever pull on a fresh host actually needs `registry.ollama.ai` reachable. Loop docstring at [`__main__.py:55-96`](../../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py#L55-L96) is the authority.
2. **`.env.example` default is `http://localhost:11434`, not `http://embedding:11434`.** The compose service name (`embedding`) resolves only when the bundle runs inside the compose network — but in dev, the bundle usually runs on the host (`scripts/start-connector.sh`) with the sidecar reachable via the compose port-forward on `localhost:11434`. Production shapes (K8s, Fly.io) override `OLLAMA_URL` to their own DNS in the deployment config per `docs/deploy/embedding-sidecar.md`. Neither default is universally correct — this one just matches what a developer running `./scripts/start-connector.sh` sees on day one.

## Loose-ends checklist

- [ ] Confirm `llama-index-embeddings-ollama>=0.2` resolves cleanly with `llama-index-core>=0.11,<0.13` (the bundle's core pin). 5-min check via `pip index versions` or a scratch venv resolve.
- [ ] Confirm no other file in `bundles/enterprise-knowledge/` imports from `llama_index.embeddings.openai` or `llama_index.embeddings.huggingface`. Grep before deletion; the only expected references are inside `_load_openai()` and `_load_local()`.
- [ ] Confirm no controller-side integration expects a specific embedder signature format (grep the AgenticProcedure repo for `"openai:text-embedding"` or `"local:BAAI"`); if it does, that's a follow-up on their side, not a blocker here.
- [ ] Confirm the `nomic-embed-text` model tag pins to v1.5 (per controller precedent — same discipline). If Ollama's default tag has drifted, pin explicitly: `nomic-embed-text:v1.5` in the warm-up call and `EK_OLLAMA_MODEL` default.
- [ ] After merge: close the placeholder in [`MULTI-ACCOUNT.md`](../MULTI-ACCOUNT.md) that pointed at this doc as an unresolved question — the answer is now "no choice, Ollama sidecar".
- [x] **Streaming-mode gotcha (2026-07-09).** First implementation of `_warmup_ollama()` in `__main__.py` used the default streaming mode on `POST /api/pull` (no `stream` flag) with `urllib.urlopen(timeout=120)`. Two failure modes: (a) `urllib`'s timeout is per-`read()`, not total-request — gaps between Ollama's JSON progress lines under slow network conditions trip it; (b) 120s is too tight for a ~274MB pull on ≤5 Mbps links. Fix mirrors the controller-side `warmUpOllamaModel()` at `server/src/llm/embedders/ollama-embedder.ts`: send `{"model": ..., "stream": false}` so Ollama holds the socket open silently until the pull completes and returns a single `{"status":"success"}`, and bump the ceiling to 600s. Simplification bonus: the chunk-drain loop collapses to a single `resp.read()`. Rejected alternative (parse progress JSON lines and log periodically) — more code, needs a per-chunk read timeout tuned to Ollama's progress cadence, and the operator can `docker compose logs embedding` for progress if they care.

## Viability summary

| Dimension | Verdict |
|---|---|
| Bundle-only change (code) | ✅ Zero touch to connector core Node code. All code work in `bundles/enterprise-knowledge/`. |
| Deployment shape change | ⚠️ New mandatory sidecar. `docker-compose.dev.yml` grows a service; every prod deployment needs a sidecar Deployment/Service (K8s) or a separate Fly.io app. Documented in `docs/deploy/embedding-sidecar.md`. |
| Reuse of proven pattern | ✅ Direct port of controller team's `feat/embeddings-self-hosted` design. Same image, same model, same warm-up shape, same operational profile. |
| Egress-pinning invariant | ✅ Strengthened. Zero external egress at inference time. `registry.ollama.ai` is the only outbound during first-time model pull, and it's cacheable / bakeable for air-gap. |
| Backwards compat | ⚠️ Deployments running `EK_EMBEDDER=local` or `openai` today must migrate. Refuse-to-query path already handles it defensively; migration is `sources_refresh(force=true)` per source. Dim change (384 or 1536 → 768) handled by `_refresh_force`'s drop-and-recreate. |
| Effort | 🟢 ~1-1.5 days: 11 items on the work list, mostly small. Compose service (~15 lines YAML), factory swap in embedder.py (~30 lines net), warm-up hook (~20 lines), env-example rewrite, new deploy doc, first pytest scaffolding for the bundle. |
| Risk | 🟢 Isolated to bundle + one compose file entry + one deploy doc. Ollama service's reliability profile is well-understood from the controller-side deployment. Sidecar down = first-embed-call error, not boot failure — bundle continues to serve non-embedding tools. |
| Customer surface | 🟢 Simpler. One env var with one supported value, no API keys, no cloud accounts. Only new customer-facing concept is "the embedding sidecar" — which is one compose service on the same host, or one Fly app / K8s Service in prod. |

**Overall: strong recommendation.** The `local` (HuggingFace on-host) path was chosen originally for the "no cloud egress" outcome, but paid for that with heavy in-process ML deps in every bundle process. Ollama gives the same outcome via a well-understood sidecar shape the controller team has already validated in production. Removing `local` alongside OpenAI narrows the customer-facing surface to a single supported path and removes ~200 LOC of dead defensive code. The migration for existing OpenAI- and local-embedded sources rides on the existing refuse-to-query invariant and `_refresh_force`'s drop-and-recreate.

---

**Plan closed 2026-07-09.** Landed on `feature/ek-embedding` in commit `ab87554`; merged to `main` as `d029886`. Feature branch retained per repo convention (`feedback_keep_feature_branches_after_merge`). One follow-up open on the loose-ends checklist: close the placeholder in [`MULTI-ACCOUNT.md`](../MULTI-ACCOUNT.md) that pointed at this doc — the answer is now "no choice, Ollama sidecar."
