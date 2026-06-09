#!/usr/bin/env bash
# Boots a single connector. The connector itself spawns Type 1 (customer-
# authored) MCP children via tsx and dials Type 2 (external) MCP servers as
# declared in packages/connector/connector.yaml. There's no per-pairing
# loop any more.
#
# To add an MCP, edit packages/connector/connector.yaml — see the example
# file for the two patterns (Type 1 / Type 2).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[start-connector] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Kill any prior runs of THIS script (their child node processes go down
# via the trap above). Don't blanket-kill node — that catches unrelated work.
echo "[start-connector] cleaning up any prior runs of this script..."
SELF_PID=$$
for pid in $(pgrep -f 'scripts/start-connector\.sh' 2>/dev/null); do
  [ "$pid" = "$SELF_PID" ] && continue
  echo "  killing prior run pid $pid"
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 1

CONNECTOR_DIR="$ROOT/packages/connector"
CONNECTOR_BIN="$CONNECTOR_DIR/dist/index.js"
ENV_FILE="$CONNECTOR_DIR/.env"
YAML_FILE="$CONNECTOR_DIR/connector.yaml"

if [ ! -f "$CONNECTOR_BIN" ]; then
  echo "[start-connector] connector not built — run: npm run build" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "[start-connector] no $ENV_FILE — copy $ENV_FILE.example and edit" >&2
  exit 1
fi
if [ ! -f "$YAML_FILE" ]; then
  echo "[start-connector] no $YAML_FILE — copy $YAML_FILE.example and edit" >&2
  exit 1
fi

# Source the connector .env so CONTROLLER_URL / TUNNEL_AUTH_TOKEN land in env
# before yaml interpolation. The connector identifies itself to the controller
# by tunnel.name on first connect; the persisted registrationToken in
# .connector-state.json is what binds it on subsequent restarts. Per-MCP creds
# (Twilio etc.) are loaded by the connector itself from each entry's dir/.env.
echo "[start-connector] sourcing $ENV_FILE"
set -a; source "$ENV_FILE"; set +a

# Type 3 bundles: when running on the host (not in the connector image), the
# in-image path /opt/bundled-mcps/<name>/ doesn't exist. For each bundle that
# has a dev-launch.sh in the sibling mcp-shim-bundled/ repo, auto-export the
# BUNDLE_DEV_OVERRIDE_<UPPER_NAME> env var so the connector spawns the local
# working tree instead. Skips silently if the sibling repo isn't there — the
# connector will then fail at boot with a clear "unknown bundle" message,
# which is the right signal.
BUNDLES_DIR="${BUNDLES_DIR:-$ROOT/../mcp-shim-bundled}"
if [ -d "$BUNDLES_DIR" ]; then
  for launcher in "$BUNDLES_DIR"/*/dev-launch.sh; do
    [ -x "$launcher" ] || continue
    bundle_name="$(basename "$(dirname "$launcher")")"
    upper_name="$(printf "%s" "$bundle_name" | tr 'a-z-' 'A-Z_')"
    var="BUNDLE_DEV_OVERRIDE_${upper_name}"
    # Don't clobber a user-supplied override.
    if [ -z "${!var:-}" ]; then
      export "$var=$launcher"
      echo "[start-connector] dev-override $var=$launcher"
    fi
  done
fi

echo "[start-connector] starting connector with CONNECTOR_CONFIG=$YAML_FILE"
CONNECTOR_CONFIG="$YAML_FILE" node "$CONNECTOR_BIN" start &

echo
echo "[start-connector] running. Ctrl-C to stop."
wait
