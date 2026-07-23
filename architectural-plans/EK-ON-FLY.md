# EK-ON-FLY — Enterprise Knowledge bundle on Fly.io

> **Goal.** Deploy the Enterprise Knowledge (Type 3) bundle alongside the mcp-connector on Fly.io — enabling on-Fly document indexing + vector search + retrieval. Preserves every load-bearing property from [CLAUDE.md](../CLAUDE.md) and complements the connector deploy already shipped in [CODE-DEPLOY.md](CODE-DEPLOY.md).
>
> **Branch (when we implement).** `feature/ek-on-fly` — cut from `main` when the design decisions in §"Design decisions" have been signed off. This document is design-only; no code lands until D1–D5 are answered.
>
> **Status: evaluation.** Recommends a concrete shape; enumerates each meaningful choice with trade-offs. Depends on [CODE-DEPLOY.md](CODE-DEPLOY.md) already being merged to `main` (the connector deploy target is a prerequisite).
>
> **Self-describing.** A fresh-context Claude should be able to read this file + [CODE-DEPLOY.md](CODE-DEPLOY.md) + [docs/deploy/embedding-sidecar.md](../docs/deploy/embedding-sidecar.md) + [mcp/bundled/enterprise-knowledge/.env.example](../mcp/bundled/enterprise-knowledge/.env.example) and start work. No hidden context.

## Context — why this is a separate workstream

The connector deploy plan ([CODE-DEPLOY.md](CODE-DEPLOY.md)) deliberately scopes EK out. Reasons:

1. **Three-app deployment, not one.** EK needs the connector app + a Postgres app with `pgvector` + an Ollama app. That's a step-function increase in complexity — cross-app networking, three secret surfaces, three restart-order sequences.
2. **Each add-on has its own D-decisions.** Which Postgres (Fly Postgres with pgvector? External?). Which Ollama model (274 MB `nomic-embed-text`? Larger?). Which Machine size for Ollama (shared-cpu-1x doesn't fit the model weights + inference; `performance-2x` minimum)?
3. **Cost.** The connector deploy is ~$5/month. EK adds ~$30–50/month (Ollama on `performance-2x` + a second Postgres with a larger volume for embeddings).
4. **Different bug surface.** The connector deploy surfaced 9 latent bugs in the OCI image + npm workspaces + Docker context layers. EK will surface a different class of bugs (Python venv paths, cross-app auth, Ollama warmup, pgvector schema migrations). Best to isolate.

**Everything in the connector deploy is a prerequisite for this.** Assume [CODE-DEPLOY.md](CODE-DEPLOY.md) is merged and the connector runs cleanly on Fly before starting here.

## Current state — what already exists

- **EK bundle source** at [`bundles/enterprise-knowledge/`](../bundles/enterprise-knowledge/) (pyproject, migrations, source, tests).
- **Bundle installed into the connector image** — the Dockerfile's `bundle-build` stage produces `/opt/bundled-mcps/enterprise-knowledge/.venv/`, which the connector spawns when yaml lists `bundled: enterprise-knowledge`.
- **Config template** at [`mcp/bundled/enterprise-knowledge/.env.example`](../mcp/bundled/enterprise-knowledge/.env.example) documenting every EK env var.
- **Embedding-sidecar design doc** at [`docs/deploy/embedding-sidecar.md`](../docs/deploy/embedding-sidecar.md) — original plan for Ollama-as-sidecar (pre-Fly; general docker-compose shape).

**What's NOT deployed:**
- No Ollama Fly app.
- No pgvector-capable Postgres (the connector's Fly Postgres doesn't have pgvector installed).
- No Drive service-account key delivered to the Machine.
- The connector.yaml on Fly has `mcp_servers: []` — no `enterprise_knowledge` entry.

## Architecturally load-bearing properties (recap)

Every property from [CLAUDE.md](../CLAUDE.md) still applies to EK on Fly. The additions specific to a three-app deployment:

- **All three apps live in the same Fly organization.** Same rule as the mock backend in [CODE-DEPLOY.md](CODE-DEPLOY.md) §D5 — `.internal` DNS is org-scoped. Cross-org would force public exposure of Ollama (a general-purpose LLM inference endpoint), which is exactly the kind of thing that ends up on someone's crypto-mining dashboard.
- **Ollama app has no public IP.** `fly ips list -a ollama-<slug>` MUST be empty. Reachable only from the connector via `.internal` at `http://ollama-<slug>.internal:11434`. This is the same enterprise-firewall analogue as the mock — Ollama stands in for the customer's own embedding service.
- **pgvector Postgres has no public IP.** Same rule.
- **Ollama chunk text never leaves the customer's Fly org.** The EK bundle's design document ([embedding-sidecar.md](../docs/deploy/embedding-sidecar.md)) is explicit about this — no external LLM APIs, no `openai.com`, no anthropic. This isn't a new rule; it's a load-bearing property EK inherits.

## Design decisions

Five choices shape the EK-on-Fly deployment. Each has a recommendation but needs explicit sign-off before implementation.

### D1 — pgvector Postgres backend

EK needs a Postgres with the `pgvector` extension installed (for vector similarity search over embedded chunks). The connector's Fly Postgres (`mcp-connector-<slug>-db`) doesn't have pgvector.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Separate Fly Postgres app with pgvector**, `ek-<slug>-db` | Second `fly postgres create --image-ref flyio/postgres-flex:16` + `CREATE EXTENSION vector;` via SQL migration in the bundle's startup path. | Cheapest ($3–5/mo). Same "unmanaged Fly Postgres" trust posture as the connector's DB. Clean isolation — connector's `mcp_connector` schema stays untouched. | Fly Postgres doesn't ship pgvector by default. Need a custom image OR `CREATE EXTENSION vector` from a superuser role, which flyctl's default `postgres` user has. |
| **(b) Reuse the connector's Fly Postgres, add pgvector extension** | `fly postgres connect -a mcp-connector-<slug>-db` → `CREATE EXTENSION IF NOT EXISTS vector;` → EK uses same DB with a different schema. | One less app to manage. Shared connection pool. Cheaper. | Blast radius merge — a schema screw-up in EK could affect the connector's row. Trust boundary blurs. Backups now cover EK too, which may or may not be desired. |
| **(c) External managed (Neon, Supabase, Aurora)** | pgvector as a first-class managed feature. | Managed backups, HA. Neon's free tier fits demos. | Adds an external vendor. Egress cost (usually free at this scale). Doesn't match the connector's "Fly Postgres for demo" story from D1 in CODE-DEPLOY.md. |
| **(d) Sibling Fly Machine running `pgvector/pgvector:pg16`** | Community pgvector image on a Fly Machine (not `fly postgres` managed). | Native pgvector, no extension-install dance. | Reinvents `fly postgres` state management (backups, upgrades). Not recommended. |

**Recommendation: (a) for demo; (c) for prod.** Reasoning:
- (a) matches the "one Fly Postgres per app" pattern the connector uses. Extension install is a one-line SQL migration in the bundle's startup path — the bundle already runs migrations idempotently per [CLAUDE.md](../CLAUDE.md).
- (b) is tempting but the trust-boundary blur is a real cost. A single misapplied migration could break both apps.
- (c) is the graduation target for production, same as D1 in CODE-DEPLOY.md.

**Open sub-questions:**
- **D1.1** — Does the EK bundle already have the `CREATE EXTENSION vector;` migration? Check [`bundles/enterprise-knowledge/migrations/`](../bundles/enterprise-knowledge/migrations/). If not, add one.
- **D1.2** — Fly Postgres's default `flyio/postgres-flex:16` image doesn't include pgvector by default. Either (i) `apt install postgresql-16-pgvector` in a custom base image, or (ii) accept that the extension install fails and the bundle refuses to start with a clear "install pgvector on your Postgres" error. (i) is proper; (ii) is faster to a working POC.

### D2 — Ollama app deployment shape

EK's embedder is Ollama (per [`.env.example`](../mcp/bundled/enterprise-knowledge/.env.example) → `EK_EMBEDDER=ollama`). Ollama needs to run somewhere Fly-reachable.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Separate Fly app `ollama-<slug>`, private-only** | Own fly.toml, own Machine, no `[[services]]`, `.internal` DNS only. Same posture as the mock backend in [CODE-DEPLOY.md §D5](CODE-DEPLOY.md#d5--mock-customer-service-deployment). | Matches the enterprise-firewall analogue. Independent scaling. Independent restart. | Two more Fly apps to manage (Ollama + pgvector). |
| **(b) Ollama as a sibling process in the connector Machine** | Multi-process fly.toml with `[processes]` — same Machine runs both connector and Ollama. | Fastest hop (localhost). No cross-app auth. | Blows up the connector image size (Ollama binary + model = ~1 GB added). Same Machine memory pressure — 512 MB isn't enough for Ollama + connector; would need `shared-cpu-2x/2GB` minimum. Kills the "connector image is small and predictable" property. |
| **(c) External Ollama** (customer's own K8s / VM) | Point `OLLAMA_URL` at an external URL. | Reuses customer's existing embedding infra. Zero Fly cost. | Requires customer to run Ollama. Doesn't demonstrate the Fly-native story. |
| **(d) Ollama Cloud API (paid)** | `EK_EMBEDDER=openai` or similar to a hosted embedding service. | Zero infra to manage. | Chunk text leaves the customer's org — violates the "never leaves customer infra" load-bearing property of EK. **Rejected.** |

**Recommendation: (a) for demos; (c) for real customer deploys.** Reasoning:
- (a) mirrors the mock backend architecture — enterprise Ollama lives in a private Fly network, unreachable from outside.
- (b) breaks two invariants (image size, Machine sizing). Rejected.
- (c) is the target production shape — customers with existing Ollama or a self-hosted TEI/HuggingFace-style endpoint plug in via `OLLAMA_URL`. Not what the demo scaffold assumes though.
- (d) violates the chunk-text-never-leaves rule. Hard rejected.

**Open sub-questions:**
- **D2.1** — Machine class for Ollama. `nomic-embed-text` is ~274 MB; the Ollama server itself + inference RAM lands at ~1–2 GB total. `shared-cpu-1x/512MB` doesn't fit; `shared-cpu-2x/2048MB` is the minimum viable. `performance-2x/4096MB` (~$25/mo) is more comfortable and gives room for larger embedding models. Recommend `performance-2x` for the scaffold default.
- **D2.2** — Persistent volume for the model cache. Ollama re-downloads the model on every restart unless `/root/.ollama` is mounted. Recommend a 5 GB Fly volume — enough for `nomic-embed-text` + one larger backup model.
- **D2.3** — Model warm-up on boot. The bundle's [`__main__.py`](../bundles/enterprise-knowledge/src/customer_ek_mcp/__main__.py) has `_warmup_ollama()` — verify it works over `.internal` DNS to a separate Fly app (not just localhost sidecar).

### D3 — Drive service-account key delivery

If the customer uses Google Drive as a source (per [`.env.example`](../mcp/bundled/enterprise-knowledge/.env.example)), the bundle needs the JSON key file at `EK_GDRIVE_SERVICE_ACCOUNT_KEY`. Fly Secrets are env-only.

Same problem as the connector's master key ([CODE-DEPLOY.md §D2](CODE-DEPLOY.md#d2--master-key-delivery-to-connector_key_file)) — solved there with an entrypoint-decode pattern. Apply the same solution here.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Entrypoint decodes `EK_GDRIVE_KEY_JSON_B64` → key file at boot** | Extend `entrypoint.sh` (or add a bundle-specific one) to base64-decode into `/etc/mcp-connector/gdrive-key.json`. Symmetric with the master-key flow. | Zero bundle code change. Consistent with connector's key delivery. | Slight complication of the entrypoint (multiple secret files). |
| **(b) Patch the bundle to accept `EK_GDRIVE_KEY_JSON_B64` directly** | The bundle's [`gdrive.py`](../bundles/enterprise-knowledge/src/customer_ek_mcp/readers/gdrive.py) reads the file today; add an env branch for the raw JSON string. | No entrypoint changes. | Widens the bundle's config surface; not portable to non-Fly platforms that DO give you file mounts. |
| **(c) Fly volume with the key file laid down manually via SSH** | `fly volumes create ek-secrets`, `fly ssh sftp shell` to push the file, mount. | Key never appears in an env var. | Manual step; can't reproduce from `fly deploy` alone. |
| **(d) Skip Drive entirely for the first deploy** | Use `EK_SOURCES_YAML` pointing at file:// paths in the image only. Drive support lands in a follow-up. | Smallest scope. Zero secret plumbing. | Doesn't demonstrate the full customer story. |

**Recommendation: (d) for the first EK-on-Fly deploy. (a) as the second iteration once (d) is proven.** Reasoning:
- (d) lets us prove the Fly deployment shape works with a minimum-viable EK — a couple of markdown docs baked into the image, indexed by the bundle on startup, queryable via `knowledge_query`. Solid demo without the Drive complexity.
- (a) is the natural next step once (d) works, and reuses the entrypoint pattern from the connector deploy — proven.
- (b) is premature abstraction until we have a second platform requesting env-based keys.

### D4 — `EK_SOURCES_YAML` delivery

The bundle reads `EK_SOURCES_YAML` at boot to auto-register sources (per [`.env.example`](../mcp/bundled/enterprise-knowledge/.env.example) L23). Currently the local dev value is an absolute host path — won't work on Fly.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Bake into image at a fixed path** | Ship `bundles/enterprise-knowledge/sources.yaml` in the OCI image; set `EK_SOURCES_YAML=/opt/bundled-mcps/enterprise-knowledge/sources.yaml`. | Deterministic. Same value across deploys. | Requires image rebuild to change sources. |
| **(b) Fly `[[files]]` block** | Same mechanism the connector uses for `config.yaml` ([CODE-DEPLOY.md §"Recommended concrete shape"](CODE-DEPLOY.md#recommended-concrete-shape)). Deliver `sources.yaml` from the local file at deploy time. | Change sources without image rebuild. Just `fly deploy`. | Sources file lives in the local repo tree, not in the customer's control plane. |
| **(c) Skip `sources.yaml`; use `<id>_register` tool calls per source** | Let the controller drive `sources_register` via the MCP tool. | Sources managed centrally on the controller. Dynamic. | Requires controller-side UX for this. Not zero-work. |

**Recommendation: (b) for demo; (c) is the target production posture.** Same graduation path as the connector's `MOCK_CUSTOMERS_URL` — controller-pushed config is the production ideal, but bake-into-image is the demo shortcut.

### D5 — `connector.yaml` entry for EK

Once EK's dependencies are up (D1 pgvector Postgres, D2 Ollama app), the connector.yaml needs a `enterprise_knowledge` entry pointing at the bundle. Currently on Fly the yaml is `mcp_servers: []`.

The entry itself is trivial (per [`connector.yaml.example`](../connector.yaml.example) in-tree, or the yaml the dev already has locally):

```yaml
mcp_servers:
  - name: enterprise_knowledge
    bundled: enterprise-knowledge
    dir: /app/mcp/bundled/enterprise-knowledge
    timeout_ms: 600000
```

Delivered via Fly `[[files]]` same as [CODE-DEPLOY.md](CODE-DEPLOY.md).

The interesting sub-questions:

- **D5.1** — EK env vars (`EK_PGVECTOR_DSN`, `OLLAMA_URL`, `EK_SOURCES_YAML`, etc.) live in a `.env` file inside `mcp/bundled/enterprise-knowledge/dir` OR set via `fly secrets` on the connector app OR pushed from the controller via `creds-request`.
  - `dir/.env` requires the file to be in the image OR mounted, and doesn't work with Fly Secrets (which are env-only).
  - **Recommendation: set via Fly Secrets on the connector app.** The connector merges Fly Secret env into the child's env at spawn time (per [CLAUDE.md](../CLAUDE.md) §"Per-entry env precedence"). Same pattern as the master key.
- **D5.2** — Cross-app URLs. `OLLAMA_URL=http://ollama-<slug>.internal:11434`, `EK_PGVECTOR_DSN=postgres://ek:pass@ek-<slug>-db.internal:5432/ek` — both use Fly private DNS. Verified pattern from the mock backend deploy in CODE-DEPLOY.md.

## Recommended concrete shape (assuming D1(a) + D2(a) + D3(d) + D4(b) + D5)

Three-app Fly deployment, all in the same Fly org:

```
┌──────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────────┐
│ mcp-connector-<slug>         │    │ ek-<slug>-db (Fly Postgres)  │    │ ollama-<slug>                │
│  - connector process         │    │  - pgvector extension        │    │  - Ollama on p2x/4GB         │
│  - EK bundle child           │    │  - EK's own schema           │    │  - 5 GB volume for models    │
│  - reaches out ──────────────┼───▶│  - reachable at              │    │  - reachable at              │
│    EK_PGVECTOR_DSN           │    │    ek-<slug>-db.internal     │    │    ollama-<slug>.internal    │
│                              │    │                              │    │    :11434                    │
│  - reaches out ──────────────┼─── │                              │    │                              │
│    OLLAMA_URL ───────────────┼────┼──────────────────────────────┼───▶│                              │
└──────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────────┘
       (fly proxy 9090:9090 to inspector — unchanged from CODE-DEPLOY.md)
```

Three apps, three fly.tomls (only the connector's at repo root; the others are self-contained in their own directories). No public IPs on any of them.

## Staged work breakdown

Ordered by dependency; each step is PR-sized.

| Step | Change | Files |
|---|---|---|
| **E1** | Verify EK bundle's Postgres migrations include `CREATE EXTENSION IF NOT EXISTS vector;` — if not, add. | `bundles/enterprise-knowledge/migrations/` |
| **E2** | Add `--target fly-ek-db` scaffold — emits a fly.toml for the pgvector-enabled Postgres app. Custom base image via `image = "flyio/postgres-flex:16"` + a boot-time SQL init that creates the extension. | [`src/deploy/scaffold.ts`](../packages/connector/src/deploy/scaffold.ts), [`src/deploy/templates.ts`](../packages/connector/src/deploy/templates.ts) |
| **E3** | Add `--target fly-ollama` scaffold — emits a fly.toml for the Ollama Fly app. `performance-2x/4096MB`, 5 GB volume at `/root/.ollama`, no `[[services]]`, `.internal` DNS only. Includes a boot-time `ollama pull nomic-embed-text` if the model isn't already cached. | Same as E2 |
| **E4** | Update connector scaffold's fly.toml template to accept an optional `--enable-ek` flag that sets the `enterprise_knowledge` yaml entry + the cross-app env vars (`EK_PGVECTOR_DSN`, `OLLAMA_URL`, `EK_SOURCES_YAML`). | Same as E2 |
| **E5** | `docs/deploy/fly-io-with-ek.md` customer walkthrough — three-app deploy in the correct order (Postgres first, then Ollama, then connector). Includes teardown script. | `docs/deploy/fly-io-with-ek.md` |
| **E6** | `deploy/fly-ek-db/` + `deploy/fly-ollama/` reference bundles — hand-authored fly.toml.example + Dockerfile (for Ollama) + README, mirroring `deploy/fly/`. | `deploy/fly-ek-db/`, `deploy/fly-ollama/` |
| **E7** | Update [`docs/deploy/README.md`](../docs/deploy/README.md) and [CLAUDE.md](../CLAUDE.md) with the three-app Fly deploy story. | `docs/deploy/*`, `CLAUDE.md` |

**Estimated effort.** E1 = ~1 hr (check + write migration if missing). E2–E4 = ~1 day (scaffold plumbing + template constants). E5–E7 = ~half day (docs). Total ~2 days for a working POC.

## What we do NOT do

- **Public IPs on any app.** Same rule as the mock backend in [CODE-DEPLOY.md §D5](CODE-DEPLOY.md). `fly ips list` MUST be empty on all three.
- **Cross-Fly-org deployment.** `.internal` DNS is org-scoped. Split-org would force public exposure of Ollama or pgvector, which violates the private-only invariant.
- **Ollama Cloud / OpenAI / Anthropic embeddings.** Chunk text never leaves the customer's Fly org — hard rule from the EK bundle's design.
- **Auto-scaling on Ollama.** `min_machines_running = 1`, `auto_stop_machines = false`. Cold-starting Ollama with model download every time = terrible warm-up latency. Machine stays warm.
- **Baking the Drive key into the image** — never. Even if committing to skip Drive in v1, don't set a precedent of image-baked credentials.

## Open design questions

- **D1.1–D1.2** — pgvector migration path + custom base image vs. runtime install
- **D2.1–D2.3** — Ollama Machine class, model cache volume, boot-time warmup over `.internal`
- **D3** — Drive key delivery (recommendation: defer to v2)
- **D4** — `EK_SOURCES_YAML` delivery mechanism
- **D5.1–D5.2** — EK env delivery (Fly Secrets vs. dir/.env vs. controller-pushed), cross-app URL wire
- **E-Meta** — is a three-app Fly demo actually the target, or do we skip straight to the "customer's own Ollama" story? If the latter, the scaffold work in E3 becomes optional.

## Prerequisites (blockers)

- [CODE-DEPLOY.md](CODE-DEPLOY.md) must be merged to `main` first. This plan assumes the connector deploy target works cleanly.
- One of the connector's Phase B lessons ([CODE-DEPLOY.md §B4](CODE-DEPLOY.md)) — `INSPECTOR_BIND_ADDR` — likely has an analogue here for `OLLAMA_URL`: does Ollama's default `0.0.0.0:11434` bind reach the Fly mesh, or does it also need `::`? Verify before E3.

## Cross-references

- [CODE-DEPLOY.md](CODE-DEPLOY.md) — connector deploy plan (parent workstream). D5 (private-only mock backend) is the closest analogue to how Ollama + pgvector-db apps are shaped here.
- [CLAUDE.md](../CLAUDE.md) — Architecturally load-bearing properties; §"Type 3 bundled" for how the connector spawns EK.
- [docs/deploy/embedding-sidecar.md](../docs/deploy/embedding-sidecar.md) — original Ollama sidecar design (pre-Fly, general docker-compose shape).
- [mcp/bundled/enterprise-knowledge/.env.example](../mcp/bundled/enterprise-knowledge/.env.example) — complete env var reference for the bundle.
- [bundles/enterprise-knowledge/README.md](../bundles/enterprise-knowledge/README.md) — bundle authoring reference.
- [bundles/enterprise-knowledge/migrations/](../bundles/enterprise-knowledge/migrations/) — Postgres migrations directory (verify pgvector extension is one of them per E1).
