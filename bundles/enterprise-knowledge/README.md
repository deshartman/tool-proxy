# enterprise-knowledge

Enterprise Knowledge MCP server — LlamaIndex-backed RAG for procedures that reference enterprise documents.

This is a [Type 3 bundle](../../CLAUDE.md): customers consume it as a single yaml line in `connector.yaml` (`bundled: enterprise-knowledge`) plus a `.env`. The connector image installs this package into its own venv at `/opt/bundled-mcps/enterprise-knowledge/` at build time. **The source tree here is a build input; only the installed venv ships in the runtime image.**

## Status

Stub backend — the four MCP tools are wired and runnable end-to-end via stdio, but the backend is in-process placeholder data. Real LlamaIndex backend (VectorStoreIndex + pgvector or Chroma + a local embedder) lands in a follow-up.

## Tools

| Tool | When | Purpose |
|---|---|---|
| `ek_register_source` | Procedure save (build time) | Synchronously fetch + parse + chunk + embed + index a URL. Returns a stable `source_id`. Idempotent on URL. |
| `ek_query` | Hydration / mid-procedure (runtime) | Vector lookup against an indexed source. Pure retrieval. |
| `ek_refresh` | Controller-driven cron | Re-fetch a source, diff, re-embed only changed chunks. |
| `ek_list_sources` | Admin UI / scheduler | List every indexed source with its metadata. |

## Running locally (host dev)

From the connector repo root:

```bash
cd bundles/enterprise-knowledge
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e .
.venv/bin/customer-ek-mcp   # speaks MCP over stdio
```

To smoke-test `tools/list`:

```bash
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
} | .venv/bin/customer-ek-mcp
```

You should see four tools in the response.

## Running under the connector (dev override)

`scripts/start-connector.sh` auto-detects every `bundles/*/dev-launch.sh` in the repo and exports `BUNDLE_DEV_OVERRIDE_<UPPER_NAME>` so the connector spawns from the working tree's venv instead of the in-image path. So once you've created the venv (above) the dev flow is just:

```bash
cd /path/to/mcp-shim
./scripts/start-connector.sh    # see EK in the inspector at http://localhost:9090/
```

The override is the customer's escape hatch, but it's also the default in dev — you don't have to do anything beyond creating the venv. To force the in-image path locally, either delete `dev-launch.sh` or unset the override env var before booting.

## Configuration (step 4)

Step 2 ignores all configuration — the stub backend has nothing to configure. Step 4 reads from the bundle's `.env` (passed in by the connector as the child's environment):

| Variable | Purpose |
|---|---|
| `EK_VECTOR_STORE` | `pgvector` (default) or `chroma` |
| `EK_PGVECTOR_DSN` | Postgres connection string when `EK_VECTOR_STORE=pgvector` |
| `EK_CHROMA_PATH` | Filesystem path when `EK_VECTOR_STORE=chroma` |
| `EK_EMBED_MODEL` | HuggingFace model id; defaults to `BAAI/bge-small-en-v1.5` (local) |

See [.env.example](.env.example) for the full list.

## Provisioning Postgres (for the pgvector backend)

When `EK_VECTOR_STORE=pgvector` (the production default), the bundle expects a Postgres 14+ instance reachable from the connector container with the `pgvector` extension installed.

Sidecar Postgres in Docker Compose:

```yaml
services:
  ek-postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: enterprise_knowledge
      POSTGRES_USER: ek
      POSTGRES_PASSWORD: ${EK_PG_PASSWORD}
    volumes:
      - ek-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ek -d enterprise_knowledge"]
      interval: 10s

  mcp-shim:
    image: mcp-shim-connector:latest
    depends_on:
      ek-postgres:
        condition: service_healthy
    environment:
      EK_VECTOR_STORE: pgvector
      EK_PGVECTOR_DSN: postgresql://ek:${EK_PG_PASSWORD}@ek-postgres:5432/enterprise_knowledge
      # ... other connector env vars ...

volumes:
  ek-postgres-data:
```

The `pgvector` extension is created automatically by the bundle on first run via the migrations in [`migrations/`](migrations/).

## Vector store choice

Default is **pgvector**. Reasons:

- Most enterprise customers already run Postgres — backups, monitoring, ACL, audit are already in place.
- One backup target for both source-metadata and chunk vectors.
- Transactional consistency between metadata writes and vector writes.

Alternative: **Chroma** (file-based, zero external service). Set `EK_VECTOR_STORE=chroma` + `EK_CHROMA_PATH`. Useful for dev, demos, or single-container deploys where adding a Postgres feels heavyweight.

## Dependencies

Step 2 (this skeleton): `mcp`, `pydantic`. That's it.

Step 4 adds: `llama-index-core`, `llama-index-vector-stores-postgres`, `llama-index-vector-stores-chroma`, `llama-index-embeddings-huggingface`, `llama-index-readers-web`, `psycopg`, `chromadb`. Held under the `[llamaindex]` extra in [pyproject.toml](pyproject.toml) for now so the stub stays installable without LlamaIndex weight.
