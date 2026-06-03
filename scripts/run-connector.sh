#!/usr/bin/env bash
# Boots one connector process per MCP server listed in MCP_DIRS.
# Each MCP server directory owns:
#   - dist/index.js          (the MCP server itself)
#   - connector.yaml         (the connector's YAML)
#   - .env                   (CONNECTOR_ID, TUNNEL_AUTH_TOKEN, INSPECTOR_PORT, PORT)
#
# Repo-root .env supplies the genuinely shared CONTROLLER_URL.
#
# Add another MCP server: append its directory to MCP_DIRS below.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# List of MCP server directories. Each must contain dist/index.js,
# connector.yaml, and .env. The Twilio one is auto-skipped if its .env
# doesn't have TWILIO_* creds set.
MCP_DIRS=(
  "examples/sample-mcp-server"
  "examples/twilio-mcp-server"
  "examples/orders-mcp-server"
)

cleanup() {
  echo
  echo "[run-connector] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Kill any prior runs of THIS script (their child node processes go down
# via the trap above).
echo "[run-connector] cleaning up any prior runs of this script..."
SELF_PID=$$
for pid in $(pgrep -f 'scripts/run-connector\.sh' 2>/dev/null); do
  [ "$pid" = "$SELF_PID" ] && continue
  echo "  killing prior run pid $pid"
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 1

# Source repo-root .env so CONTROLLER_URL lands in env before child procs.
ROOT_ENV="$ROOT/.env"
if [ -f "$ROOT_ENV" ]; then
  echo "[run-connector] sourcing $ROOT_ENV"
  set -a; source "$ROOT_ENV"; set +a
else
  echo "[run-connector] no .env at repo root — proceeding with current shell env"
  echo "  (copy .env.example to .env and set CONTROLLER_URL)"
fi

CONNECTOR_BIN="$ROOT/packages/connector/dist/index.js"
if [ ! -f "$CONNECTOR_BIN" ]; then
  echo "[run-connector] connector not built — run: npm run build" >&2
  exit 1
fi

start_pairing() {
  local dir="$1"
  local abs="$ROOT/$dir"
  local env_file="$abs/.env"
  local yaml_file="$abs/connector.yaml"
  local server_bin="$abs/dist/index.js"

  if [ ! -f "$server_bin" ]; then
    echo "[run-connector] $dir: no dist/index.js — run: (cd $dir && npm install && npm run build) — skipping"
    return
  fi
  if [ ! -f "$env_file" ]; then
    echo "[run-connector] $dir: no .env — copy .env.example to .env and fill in — skipping"
    return
  fi
  if [ ! -f "$yaml_file" ]; then
    echo "[run-connector] $dir: no connector.yaml — copy connector.yaml.example — skipping"
    return
  fi

  # Pull this pairing's vars in a subshell so values don't leak into
  # the parent (or the next iteration).
  local conn_id port inspector_port has_twilio_creds
  read -r conn_id port inspector_port has_twilio_creds <<<"$(
    set -a; source "$env_file"; set +a
    twilio=0
    [ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ] && twilio=1
    echo "${CONNECTOR_ID:-?} ${PORT:-?} ${INSPECTOR_PORT:-?} $twilio"
  )"

  # The Twilio MCP server boots fail-fast if TWILIO_* aren't set. Detect
  # and skip cleanly so the script doesn't crash on a missing-creds .env.
  if grep -q '^TWILIO_ACCOUNT_SID=' "$env_file" && [ "$has_twilio_creds" = "0" ]; then
    echo "[run-connector] $dir: TWILIO_* present in .env but empty — skipping (set creds to enable)"
    return
  fi

  echo "[run-connector] $dir: starting MCP server on :$port and connector on inspector :$inspector_port (id=$conn_id)..."
  (cd "$abs" && set -a; source "$env_file"; set +a; node dist/index.js) &
  sleep 1
  (cd "$abs" && set -a; source "$env_file"; set +a; \
    CONNECTOR_CONFIG="$yaml_file" \
    INSPECTOR_PORT="$inspector_port" \
    node "$CONNECTOR_BIN" start) &
}

for dir in "${MCP_DIRS[@]}"; do
  start_pairing "$dir"
done

echo
echo "[run-connector] running. Ctrl-C to stop."
wait
