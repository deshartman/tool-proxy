#!/usr/bin/env bash
# Boots a single connector for local development. The connector itself
# spawns Type 1 (customer-authored) MCP children via tsx and dials Type 2
# (external) MCP servers as declared in ./connector.yaml (at the repo
# root — resolved from CWD by the connector; production containers mount
# config at /etc/mcp-connector/ instead).
#
# To add an MCP, edit ./connector.yaml — see connector/connector.yaml.example
# for the two patterns (Type 1 / Type 2).

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

CONNECTOR_DIR="$ROOT/connector"
CONNECTOR_BIN="$CONNECTOR_DIR/dist/index.js"
# Live config lives at the repo root — the connector resolves .env and
# connector.yaml from CWD. In production containers, the customer mounts
# these at /etc/mcp-connector/ (or a custom path). The *.example templates
# ship inside connector/ and are the source `init` copies from.
ENV_FILE="$ROOT/.env"
YAML_FILE="$ROOT/connector.yaml"
MOCK_DATA_FILE="$ROOT/examples/mock-backend/data.ts"

# Rebuild if dist/ is missing OR stale relative to source. Without this, a
# source-only edit (e.g. a fix to src/boot/lifecycle.ts) silently runs the
# previous build — the connector boots successfully, looks correct, but
# the change isn't in the running bundle. Caught manually on 2026-06-26.
#
# Anchor: tsconfig.tsbuildinfo (rewritten on every tsc -b invocation,
# including no-op runs). dist/index.js is NOT a reliable anchor because
# tsc preserves output file mtimes when content is unchanged.
#
# `find -quit` short-circuits on the first match so this is cheap on a
# clean tree.
TSBUILDINFO="$CONNECTOR_DIR/tsconfig.tsbuildinfo"
needs_build=0
if [ ! -f "$CONNECTOR_BIN" ] || [ ! -f "$TSBUILDINFO" ]; then
  needs_build=1
else
  newer=$(find "$CONNECTOR_DIR/src" -type f \( -name '*.ts' -o -name '*.json' \) \
          -newer "$TSBUILDINFO" -print -quit 2>/dev/null)
  if [ -z "$newer" ]; then
    for tsc in "$CONNECTOR_DIR/tsconfig.json" "$ROOT/tsconfig.base.json"; do
      [ -f "$tsc" ] && [ "$tsc" -nt "$TSBUILDINFO" ] && newer="$tsc" && break
    done
  fi
  [ -n "$newer" ] && needs_build=1
fi
if [ "$needs_build" = "1" ]; then
  echo "[start-connector] building connector (dist/ missing or stale)..."
  (cd "$CONNECTOR_DIR" && npm run build)
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "[start-connector] no $ENV_FILE — copy $CONNECTOR_DIR/.env.example to $ENV_FILE and edit" >&2
  exit 1
fi
if [ ! -f "$YAML_FILE" ]; then
  echo "[start-connector] no $YAML_FILE — copy $CONNECTOR_DIR/connector.yaml.example to $YAML_FILE and edit" >&2
  exit 1
fi
if [ ! -f "$MOCK_DATA_FILE" ]; then
  echo "[start-connector] no $MOCK_DATA_FILE — copy $MOCK_DATA_FILE.example and edit (it's gitignored; replace Dana Demo with your real number for live calls)" >&2
  exit 1
fi

# Per-MCP deps install: every folder under bundled-mcps/ or customer-mcps/
# that ships its own package.json with third-party SDK deps installs into its
# own node_modules so those SDKs never hoist into the connector workspace.
# The Dockerfile runs the same loop at image-build time; this is the dev-mode
# mirror. Folders with no package.json or an empty dependencies block skip
# cleanly — framework imports (zod, the connector SDK) resolve via Node's
# parent-dir walk to the workspace root. Bump a dep version in package.json
# while node_modules already exists? This loop won't notice — run
# `npm install` in that folder yourself.
for dir in "$ROOT"/bundled-mcps/*/ "$ROOT"/customer-mcps/*/; do
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

# Preflight: if EK_EMBEDDER is set (bundle enabled), ensure Ollama sidecar
# is running. Cleaner failure than a mysterious first-query timeout.
if [ "${EK_EMBEDDER:-}" = "ollama" ]; then
  if ! docker compose -f "$ROOT/docker-compose.dev.yml" ps embedding --status running --format json 2>/dev/null | grep -q "mcp-shim-embedding"; then
    echo "[start-connector] ERROR: EK_EMBEDDER=ollama but the 'embedding' service is not running." >&2
    echo "[start-connector] Start it with: docker compose -f docker-compose.dev.yml up -d embedding" >&2
    exit 1
  fi
  echo "[start-connector] Ollama embedding sidecar is running"
fi

# Type 3 bundles: when running on the host (not in the connector image), the
# in-image path /opt/bundled-mcps/<name>/ doesn't exist. For each bundle
# under bundled-mcps/<name>/source/ (where the source lives) that ships a
# dev-launch.sh, auto-export BUNDLE_DEV_OVERRIDE_<UPPER_NAME> so the connector
# spawns the local working tree's venv instead. Each bundle's README documents
# creating that venv (`uv venv .venv` + `uv pip install -e .`); the launcher
# requires it.
for launcher in "$ROOT"/bundled-mcps/*/source/dev-launch.sh; do
  [ -x "$launcher" ] || continue
  # launcher = bundled-mcps/<name>/source/dev-launch.sh — <name> is TWO dirs up
  bundle_name="$(basename "$(dirname "$(dirname "$launcher")")")"
  upper_name="$(printf "%s" "$bundle_name" | tr 'a-z-' 'A-Z_')"
  var="BUNDLE_DEV_OVERRIDE_${upper_name}"
  # Don't clobber a user-supplied override.
  if [ -z "${!var:-}" ]; then
    export "$var=$launcher"
    echo "[start-connector] dev-override $var=$launcher"
  fi
done

# Drop-in MCP dir: in dev we point at mcp/local/ so tools/*.ts folders that
# don't carry a hand-written server.ts get auto-discovered by the connector
# (W-A1/A2 of MCP-LOADING). Production images use the customer-mount path
# /var/lib/mcp-connector/customer-mcps/. Don't clobber a user-supplied value.
if [ -z "${MCP_DROPIN_DIR:-}" ]; then
  export MCP_DROPIN_DIR="$ROOT/mcp/local"
  echo "[start-connector] MCP_DROPIN_DIR=$MCP_DROPIN_DIR"
fi

echo "[start-connector] starting connector with CONNECTOR_CONFIG=$YAML_FILE"
CONNECTOR_CONFIG="$YAML_FILE" node "$CONNECTOR_BIN" start &

echo
echo "[start-connector] running. Ctrl-C to stop."
wait
