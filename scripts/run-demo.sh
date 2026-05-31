#!/usr/bin/env bash
# Boots the shims (and, depending on mode, the main server and/or local-server).
#
# Modes:
#   dev   (default) — main server runs locally; shims dial localhost.
#                     Reads:  packages/main-server/.env.dev
#                             packages/shim/config/shim-a.env.dev
#                             packages/shim/config/shim-b.env.dev
#
#   local           — shims dial a remote main server (e.g. Fly).
#                     Main server NOT started locally.
#                     Reads:  packages/shim/config/shim-a.env.local
#                             packages/shim/config/shim-b.env.local
#
#   local-ui        — same as `local`, plus a laptop-side local-server process
#                     so a second browser tab can show the shim's view AND
#                     handle Change-document requests locally on the laptop.
#                     Reads:  packages/local-server/.env.local-ui
#                             packages/shim/config/shim-a.env.local-ui
#                             packages/shim/config/shim-b.env.local-ui
#                     Browser tabs:
#                       Fly chat tab: https://<your-fly-app>/?view=chat
#                       Laptop shim tab: http://localhost:9000/?view=shim
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
  dev|local|local-ui) ;;
  *)
    echo "usage: $0 [dev|local|local-ui]" >&2
    exit 64
    ;;
esac

cleanup() {
  echo
  echo "[demo] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Optional local main-server (dev only) -------------------------------
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
elif [ "$MODE" = "local" ]; then
  echo "[demo] mode=local: shims will dial remote MAIN_SERVER_URL from each shim env file"
else
  echo "[demo] mode=local-ui: shims dial remote MAIN_SERVER_URL AND fan out to local local-server"
fi

# --- Optional local-server (local-ui only) -------------------------------
if [ "$MODE" = "local-ui" ]; then
  # Restart the Fly machine before connecting so the demo always starts
  # against a fresh tunnel state. Fly's HTTP idle timer will eventually
  # close stale tunnels; rather than coding heartbeat/reconnect logic we
  # only need at demo time, the cheaper fix is to kick the machine here.
  # Skip with FLY_RESTART=0 if you want to dial straight in.
  if [ "${FLY_RESTART:-1}" != "0" ]; then
    if command -v flyctl >/dev/null 2>&1; then
      # `flyctl machine restart` is non-interactive-hostile: it requires an
      # explicit machine ID. Discover it via `machine list --json`. We pin
      # to a single machine in fly.toml, so taking the first one is fine.
      FLY_MACHINE_ID="$(flyctl machine list -a mcp-shim-poc --json 2>/dev/null \
        | python3 -c 'import json,sys; ms=json.load(sys.stdin); print(ms[0]["id"] if ms else "")')"
      if [ -n "$FLY_MACHINE_ID" ]; then
        echo "[demo] restarting Fly machine $FLY_MACHINE_ID for fresh tunnel..."
        flyctl machine restart "$FLY_MACHINE_ID" -a mcp-shim-poc 2>&1 | sed 's/^/[fly] /' || \
          echo "[demo] WARNING: flyctl machine restart failed — continuing anyway"
        echo "[demo] waiting for Fly to come back online..."
        for i in 1 2 3 4 5 6 7 8 9 10; do
          if curl -sf -o /dev/null https://mcp-shim-poc.fly.dev/registry; then
            echo "[demo] Fly is live"
            break
          fi
          sleep 2
        done
      else
        echo "[demo] WARNING: could not discover Fly machine ID — skipping restart"
      fi
    else
      echo "[demo] WARNING: flyctl not found on PATH — skipping Fly restart"
    fi
  fi

  LOCAL_SERVER_ENV="$ROOT/packages/local-server/.env.local-ui"
  if [ ! -f "$LOCAL_SERVER_ENV" ]; then
    echo "[demo] missing $LOCAL_SERVER_ENV — copy from .env.local-ui.example" >&2
    exit 1
  fi
  echo "[demo] starting local-server..."
  (set -a; source "$LOCAL_SERVER_ENV"; \
    SHIM_CONFIGS="$ROOT/packages/shim/config/shim-a.yaml,$ROOT/packages/shim/config/shim-b.yaml"; \
    set +a; \
    cd "$ROOT/packages/local-server" && node dist/index.js) &
  sleep 1
fi

# --- Shims ---------------------------------------------------------------
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
case "$MODE" in
  dev)
    echo "  open http://localhost:8080/"
    ;;
  local)
    echo "  open the MAIN_SERVER_URL host (without /tunnel) in your browser"
    ;;
  local-ui)
    echo "  Tab 1 (cloud): open https://<your-fly-app>/?view=chat"
    echo "  Tab 2 (shim):  open http://localhost:9000/?view=shim"
    ;;
esac
echo
echo "[demo] Ctrl-C to stop."
wait
