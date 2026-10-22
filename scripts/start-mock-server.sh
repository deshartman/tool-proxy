#!/usr/bin/env bash
# Boots the mock customer service used by the crm MCP demo. Dev-only.
# Zero-config on a fresh clone: auto-provisions the dev Postgres container,
# auto-creates the `crm` database, and defaults MOCK_POSTGRES_URL — no .env
# template to copy. Reads examples/mock-backend/.env if present (wins over
# auto-provisioning). Default PORT is 7400.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[mock-customers] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

MOCK_DIR="$ROOT/examples/mock-backend"
ENV_FILE="$MOCK_DIR/.env"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.dev.yml"
DEV_PG_CONTAINER="tool-proxy-postgres"
DEV_MOCK_PG_URL="postgres://mcp:mcp-dev-password@localhost:5433/crm"

if [ -f "$ENV_FILE" ]; then
  echo "[mock-customers] sourcing $ENV_FILE (optional override)"
  set -a; source "$ENV_FILE"; set +a
fi

# Auto-provision the dev Postgres + crm DB if MOCK_POSTGRES_URL isn't already
# set. This script is now the ONLY consumer of the dev Postgres — the connector
# used to bootstrap it too for its own config store, until DB-TO-FILE made that
# a sealed JSON file. The compose file only seeds `mcp_connector` (a vestigial
# name kept for the readiness probe); `crm` is the mock-backend's DB and needs a
# separate CREATE (idempotent — the pg_database probe skips it on later runs).
if [ -z "${MOCK_POSTGRES_URL:-}" ]; then
  if ! docker ps --filter "name=$DEV_PG_CONTAINER" --format '{{.Names}}' | grep -q .; then
    echo "[mock-customers] starting dev Postgres ($DEV_PG_CONTAINER)..."
    docker compose -f "$COMPOSE_FILE" up -d postgres
    echo -n "[mock-customers] waiting for Postgres readiness"
    for _ in $(seq 1 30); do
      if docker exec "$DEV_PG_CONTAINER" pg_isready -U mcp -d mcp_connector >/dev/null 2>&1; then
        echo " — ready"
        break
      fi
      echo -n "."
      sleep 1
    done
  fi
  if ! docker exec "$DEV_PG_CONTAINER" psql -U mcp -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='crm'" | grep -q 1; then
    echo "[mock-customers] creating crm database..."
    docker exec "$DEV_PG_CONTAINER" psql -U mcp -d postgres -c "CREATE DATABASE crm"
  fi
  export MOCK_POSTGRES_URL="$DEV_MOCK_PG_URL"
  echo "[mock-customers] MOCK_POSTGRES_URL auto-set: $MOCK_POSTGRES_URL"
fi

# tsx ships with the connector workspace; reuse it.
TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "[mock-customers] tsx not found at $TSX — run: npm install" >&2
  exit 1
fi

echo "[mock-customers] starting on PORT=${PORT:-7400}"
exec "$TSX" "$MOCK_DIR/server.ts"
