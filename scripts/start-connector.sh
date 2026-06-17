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
MOCK_DATA_FILE="$ROOT/mock/customers/data.ts"

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
if [ ! -f "$MOCK_DATA_FILE" ]; then
  echo "[start-connector] no $MOCK_DATA_FILE — copy $MOCK_DATA_FILE.example and edit (it's gitignored; replace Dana Demo with your real number for live calls)" >&2
  exit 1
fi

# Per-MCP install: every Type 1 folder that ships its own package.json with
# third-party SDK deps is self-contained — those SDKs live in the folder's
# own node_modules so they never hoist into the connector workspace. On
# first run (or any time a folder's node_modules has been blown away)
# install its deps before booting. The Dockerfile runs the same loop at
# image-build time; this is the dev-mode mirror.
# Folders with no package.json, or with an empty `dependencies` block
# (sample, crm today) skip cleanly — their imports (zod, the connector
# SDK) resolve via Node's parent-dir walk to the workspace root.
# Note: if you bump a dep version in package.json but node_modules
# already exists, this loop won't notice — run `npm install` in that
# folder yourself to pick up the new version.
for dir in "$ROOT"/mcp/local/*/ "$ROOT"/mcp/external/*/ "$ROOT"/mcp/bundled/*/; do
  [ -f "$dir/package.json" ] || continue
  depcount=$(node -e "console.log(Object.keys(require('$dir/package.json').dependencies||{}).length)" 2>/dev/null || echo 0)
  [ "$depcount" = "0" ] && continue
  if [ ! -d "$dir/node_modules" ]; then
    echo "[start-connector] installing deps in ${dir#$ROOT/}"
    (cd "$dir" && npm install --omit=dev --no-package-lock --silent)
  fi
done

# Source the connector .env so CONTROLLER_URL / TUNNEL_AUTH_TOKEN land in env
# before yaml interpolation. The connector identifies itself to the controller
# by tunnel.name on first connect; the persisted registrationToken in
# .connector-state.json is what binds it on subsequent restarts. Per-MCP creds
# (Twilio etc.) are loaded by the connector itself from each entry's dir/.env.
echo "[start-connector] sourcing $ENV_FILE"
set -a; source "$ENV_FILE"; set +a

# Type 3 bundles: when running on the host (not in the connector image), the
# in-image path /opt/bundled-mcps/<name>/ doesn't exist. For each bundle
# under bundles/<name>/ (where the source lives) that ships a dev-launch.sh,
# auto-export BUNDLE_DEV_OVERRIDE_<UPPER_NAME> so the connector spawns the
# local working tree's venv instead. Each bundle's README documents creating
# that venv (`uv venv .venv` + `uv pip install -e .`); the launcher requires
# it. (mcp/bundled/<name>/ on the runtime path holds only the .env stub.)
for launcher in "$ROOT"/bundles/*/dev-launch.sh; do
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

echo "[start-connector] starting connector with CONNECTOR_CONFIG=$YAML_FILE"
CONNECTOR_CONFIG="$YAML_FILE" node "$CONNECTOR_BIN" start &

echo
echo "[start-connector] running. Ctrl-C to stop."
wait
