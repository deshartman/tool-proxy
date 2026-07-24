# Docker Compose

Two compose files ship here:

- **`docker-compose.prod.yml`** — single-VM production shape. Connector +
  sibling Postgres (for db mode) + a Docker-managed secret file for the
  master key. Bind the inspector to `127.0.0.1:9090` only. Never expose it
  to a public interface — the Webhooks panel surfaces bcrypt-protected
  URLs by design.
- **`docker-compose.dev.yml`** — dev-time overrides (Ollama embedding
  sidecar for the Enterprise Knowledge bundle, hot-reload knobs). Pair
  with the prod file: `docker compose -f docker-compose.prod.yml -f
  docker-compose.dev.yml up`.

Copy `.env.example` → `.env` and fill in `POSTGRES_URL`, `CONNECTOR_KEY_FILE`
(or `CONNECTOR_KEY_B64` if your host mounts secrets as env vars), and any
per-MCP creds you don't manage through the controller UI.

## Load-bearing invariants

The compose files hardcode a few properties the connector relies on. Don't
edit them out:

- `127.0.0.1:9090:9090` inspector port binding — inspector is loopback-only.
- Postgres password sourced from a file secret, not baked inline.
- No `restart: always` on the connector container (systemd / K8s handle
  supervision; docker's restart policy would mask a fail-fast during
  early boot).

Pinned by [`connector/tests/compose/compose-lint.test.ts`](../../connector/tests/compose/compose-lint.test.ts).

## See also

- Umbrella: [`deploy/README.md`](../README.md).
- Enterprise-Knowledge sidecar wiring: [`bundled-mcps/enterprise-knowledge/EMBEDDING-SIDECAR.md`](../../bundled-mcps/enterprise-knowledge/EMBEDDING-SIDECAR.md).
