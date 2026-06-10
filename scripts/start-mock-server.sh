#!/usr/bin/env bash
# Boots the mock customer service used by the orders MCP demo. Dev-only.
# Reads optional PORT from mock/customers/.env (default 7200).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[mock-customers] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

MOCK_DIR="$ROOT/mock/customers"
ENV_FILE="$MOCK_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  echo "[mock-customers] sourcing $ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
fi

# tsx ships with the connector workspace; reuse it.
TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "[mock-customers] tsx not found at $TSX — run: npm install" >&2
  exit 1
fi

echo "[mock-customers] starting on PORT=${PORT:-7400}"
exec "$TSX" "$MOCK_DIR/server.ts"
