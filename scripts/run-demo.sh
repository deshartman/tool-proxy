#!/usr/bin/env bash
# Boots the shims (and, in dev mode, the main server) for the POC demo.
#
# Modes:
#   dev   (default) — main server runs locally; shims dial localhost.
#                     Reads:  packages/main-server/.env.dev
#                             packages/shim/config/shim-a.env.dev
#                             packages/shim/config/shim-b.env.dev
#
#   local           — shims on this laptop dial a remote main server (e.g. Fly).
#                     The main server is NOT started locally in this mode.
#                     Reads:  packages/shim/config/shim-a.env.local
#                             packages/shim/config/shim-b.env.local
#
# Prereqs (per mode):
#   - npm install (from repo root)
#   - npm run build
#   - copy each .env.<mode>.example to its corresponding .env.<mode> file
#     and fill in keys.

set -euo pipefail

MODE="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "$MODE" in
  dev|local) ;;
  *)
    echo "usage: $0 [dev|local]" >&2
    exit 64
    ;;
esac

cleanup() {
  echo
  echo "[demo] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$MODE" = "dev" ]; then
  MAIN_ENV="$ROOT/packages/main-server/.env.dev"
  if [ ! -f "$MAIN_ENV" ]; then
    echo "[demo] missing $MAIN_ENV — copy from .env.dev.example" >&2
    exit 1
  fi
  echo "[demo] mode=dev: starting main server..."
  (set -a; source "$MAIN_ENV"; set +a; \
    cd "$ROOT/packages/main-server" && node dist/index.js) &
  sleep 1
else
  echo "[demo] mode=local: shims will dial the remote MAIN_SERVER_URL from each shim env file"
fi

SHIM_A_ENV="$ROOT/packages/shim/config/shim-a.env.${MODE}"
SHIM_B_ENV="$ROOT/packages/shim/config/shim-b.env.${MODE}"
for f in "$SHIM_A_ENV" "$SHIM_B_ENV"; do
  if [ ! -f "$f" ]; then
    echo "[demo] missing $f — copy from $(basename "$f").example" >&2
    exit 1
  fi
done

echo "[demo] starting shim-a (env: $(basename "$SHIM_A_ENV"))..."
(set -a; source "$SHIM_A_ENV"; set +a; \
  cd "$ROOT/packages/shim" && node dist/index.js) &

echo "[demo] starting shim-b (env: $(basename "$SHIM_B_ENV"))..."
(set -a; source "$SHIM_B_ENV"; set +a; \
  cd "$ROOT/packages/shim" && node dist/index.js) &

echo
echo "[demo] all processes up. Try:"
if [ "$MODE" = "dev" ]; then
  echo "  curl -s http://localhost:8080/registry | jq ."
  echo "  open http://localhost:8080/"
else
  echo "  open the MAIN_SERVER_URL host (without /tunnel) in your browser"
fi
echo
echo "[demo] Ctrl-C to stop."
wait
