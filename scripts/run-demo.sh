#!/usr/bin/env bash
# Boots the main server and both shims for the POC demo.
#
# Prereqs:
#   - npm install (from repo root)
#   - npm run build
#   - copy each .env.example to its corresponding .env file and fill in keys:
#       packages/main-server/.env
#       packages/shim/config/shim-a.env
#       packages/shim/config/shim-b.env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[demo] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[demo] starting main server..."
(cd "$ROOT/packages/main-server" && node dist/index.js) &
sleep 1

echo "[demo] starting shim-a..."
(set -a; source "$ROOT/packages/shim/config/shim-a.env"; set +a; \
  cd "$ROOT/packages/shim" && node dist/index.js) &

echo "[demo] starting shim-b..."
(set -a; source "$ROOT/packages/shim/config/shim-b.env"; set +a; \
  cd "$ROOT/packages/shim" && node dist/index.js) &

echo
echo "[demo] all processes up. Try:"
echo "  curl -s http://localhost:8080/registry | jq ."
echo "  curl -s -X POST http://localhost:8080/query \\"
echo "    -H 'content-type: application/json' \\"
echo "    -d '{\"q\":\"Our database is down, what do I do?\"}' | jq ."
echo
echo "[demo] Ctrl-C to stop."
wait
