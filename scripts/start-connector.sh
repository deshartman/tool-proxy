#!/usr/bin/env bash
# Boots a single connector for local development. Zero-config on a fresh
# clone: auto-provisions the dev Postgres container, auto-mints the master
# key, and injects both env vars into the connector's process — no .env
# template to copy, no manual pre-boot step.
#
# Overrides (all optional):
#   POSTGRES_URL              — dev-Postgres DSN (default: docker-compose ek-postgres)
#   CONNECTOR_KEY_FILE        — libsodium master key path (default: .local/master.key, auto-minted)
#   MCP_DROPIN_DIR            — customer drop-ins (default: ./customer-mcps)
#   MCP_BUNDLED_DIR           — Twilio-shipped MCPs (default: ./bundled-mcps)
#   $ROOT/.env                — sourced if present, wins over auto-provisioned values

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
# .env is OPTIONAL in dev — the script auto-provisions POSTGRES_URL +
# CONNECTOR_KEY_FILE below. Respected if present so devs can override.
ENV_FILE="$ROOT/.env"
YAML_FILE="$ROOT/connector.yaml"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.dev.yml"
DEV_PG_CONTAINER="mcp-shim-ek-postgres"
DEV_PG_URL="postgres://ek:ek-dev-password@localhost:5433/enterprise_knowledge"
DEV_MASTER_KEY="$ROOT/.local/master.key"

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
if [ ! -f "$YAML_FILE" ]; then
  # Bare-minimum starter — the connector still loads yaml at boot, but with
  # every MCP coming from bundled-mcps/ + customer-mcps/ scanners + controller
  # push, a customer-authored yaml can be near-empty. Users who want a Type 3
  # bundled entry (e.g. enterprise-knowledge) or a hand-written Type 1 add
  # entries under mcp_servers manually.
  cat >&2 <<EOF
[start-connector] no $YAML_FILE — creating a minimal starter.
To wire yaml-managed entries (Type 3 bundled MCPs like enterprise-knowledge,
or legacy hand-written Type 1), edit this file. Otherwise leave it alone;
bundled + customer-mcps/ auto-discovery covers most setups.
EOF
  cat > "$YAML_FILE" <<'YAML_EOF'
mcp_servers: []
policy:
  fail_mode: fail_fast
YAML_EOF
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

# ─── Env bootstrap (zero-config dev) ──────────────────────────────────────
# The connector needs POSTGRES_URL + CONNECTOR_KEY_FILE in its process env.
# Order:
#   1. .env at repo root (optional) — sourced if present. Lets devs override
#      the auto-provisioned defaults or wire in additional vars.
#   2. Auto-provisioned defaults for anything still unset:
#      - POSTGRES_URL → docker-compose ek-postgres (auto-started if not up)
#      - CONNECTOR_KEY_FILE → .local/master.key (auto-minted if missing)
# No .env template to copy, no manual pre-boot step. First-run on a fresh
# clone works.
if [ -f "$ENV_FILE" ]; then
  echo "[start-connector] sourcing $ENV_FILE (optional override)"
  set -a; source "$ENV_FILE"; set +a
fi

# Auto-provision dev Postgres if POSTGRES_URL isn't already set.
if [ -z "${POSTGRES_URL:-}" ]; then
  if ! docker ps --filter "name=$DEV_PG_CONTAINER" --format '{{.Names}}' | grep -q .; then
    echo "[start-connector] starting dev Postgres ($DEV_PG_CONTAINER)..."
    docker compose -f "$COMPOSE_FILE" up -d ek-postgres
    echo -n "[start-connector] waiting for Postgres readiness"
    for _ in $(seq 1 30); do
      if docker exec "$DEV_PG_CONTAINER" pg_isready -U ek -d enterprise_knowledge >/dev/null 2>&1; then
        echo " — ready"
        break
      fi
      echo -n "."
      sleep 1
    done
  fi
  export POSTGRES_URL="$DEV_PG_URL"
  echo "[start-connector] POSTGRES_URL auto-set: $POSTGRES_URL"
fi

# Auto-mint the 32-byte libsodium master key on first run.
if [ -z "${CONNECTOR_KEY_FILE:-}" ]; then
  export CONNECTOR_KEY_FILE="$DEV_MASTER_KEY"
fi
if [ ! -f "$CONNECTOR_KEY_FILE" ]; then
  echo "[start-connector] minting master key at $CONNECTOR_KEY_FILE"
  mkdir -p "$(dirname "$CONNECTOR_KEY_FILE")"
  head -c 32 /dev/urandom > "$CONNECTOR_KEY_FILE"
  chmod 400 "$CONNECTOR_KEY_FILE"
fi

# Preflight: if EK_EMBEDDER is set (bundle enabled), ensure Ollama sidecar
# is running. Cleaner failure than a mysterious first-query timeout.
if [ "${EK_EMBEDDER:-}" = "ollama" ]; then
  if ! docker compose -f "$ROOT/deploy/compose/docker-compose.dev.yml" ps embedding --status running --format json 2>/dev/null | grep -q "mcp-shim-embedding"; then
    echo "[start-connector] ERROR: EK_EMBEDDER=ollama but the 'embedding' service is not running." >&2
    echo "[start-connector] Start it with: docker compose -f deploy/compose/docker-compose.dev.yml up -d embedding" >&2
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

# Drop-in MCP dir: in dev we point at customer-mcps/ so tools/*.ts folders
# get auto-discovered by the connector (W-A1/A2 of MCP-LOADING). Production
# images use the customer-mount path /var/lib/mcp-connector/customer-mcps/.
# Don't clobber a user-supplied value.
if [ -z "${MCP_DROPIN_DIR:-}" ]; then
  export MCP_DROPIN_DIR="$ROOT/customer-mcps"
  echo "[start-connector] MCP_DROPIN_DIR=$MCP_DROPIN_DIR"
fi

# Bundled MCP dir: in dev we point at bundled-mcps/ so Twilio-shipped MCPs
# (agentic-memory, enterprise-knowledge stub) get auto-discovered. Production
# images bake this to /app/bundled-mcps via the Dockerfile's ENV directive.
# D1 (always on) — no allowlist, no gate; every folder here registers.
if [ -z "${MCP_BUNDLED_DIR:-}" ]; then
  export MCP_BUNDLED_DIR="$ROOT/bundled-mcps"
  echo "[start-connector] MCP_BUNDLED_DIR=$MCP_BUNDLED_DIR"
fi

echo "[start-connector] starting connector with CONNECTOR_CONFIG=$YAML_FILE"
CONNECTOR_CONFIG="$YAML_FILE" node "$CONNECTOR_BIN" start &

echo
echo "[start-connector] running. Ctrl-C to stop."
wait
