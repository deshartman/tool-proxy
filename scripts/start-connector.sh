#!/usr/bin/env bash
# Boots a single connector for local development. Zero-config on a fresh
# clone: auto-provisions the dev Postgres container, auto-mints the master
# key, and injects both env vars into the connector's process — no .env
# template to copy, no manual pre-boot step.
#
# Overrides (all optional):
#   CONNECTOR_STATE_DIR       — sealed config store dir (default: .local/state-<port>)
#   CONNECTOR_KEY_FILE        — libsodium master key path (default: .local/master.key, auto-minted)
#   MCP_DROPIN_DIR            — customer drop-ins (default: ./customer-mcps)
#   MCP_BUNDLED_DIR           — Twilio-shipped MCPs (default: ./bundled-mcps)
#   $ROOT/.env                — sourced if present, wins over auto-provisioned values

set -euo pipefail

# ─── Multi-instance: optional port arg (see architectural-plans/MULTI-INSTANCE.md) ─
# First arg is the inspector port (default 9090). Enables running multiple
# connector instances on one host, each dialing a different controller.
# Path B naming: port 9090 uses the historical 'mcp_connector' schema
# (preserves existing state); other ports get 'mcp_connector_<port>'.
# Port-derived env exports are applied later, right before spawning node,
# so they win over anything sourced from .env.
PORT="${1:-9090}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Per-port PID file. Same port → kill prior instance. Different port →
# instances coexist. Replaces the old pgrep-by-filename kill which took
# down siblings on other ports.
mkdir -p "$ROOT/.local"
PIDFILE="$ROOT/.local/pid-${PORT}"

cleanup() {
  echo
  echo "[start-connector] shutting down (port $PORT)..."
  rm -f "${PIDFILE:-}" 2>/dev/null || true
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-connector] killing prior instance on port $PORT (pid $OLD_PID)"
    kill -TERM "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi
echo $$ > "$PIDFILE"

CONNECTOR_DIR="$ROOT/connector"
CONNECTOR_BIN="$CONNECTOR_DIR/dist/index.js"
# .env is OPTIONAL in dev — the script auto-provisions CONNECTOR_KEY_FILE
# below. Respected if present so devs can override.
ENV_FILE="$ROOT/.env"
YAML_FILE="$ROOT/connector.yaml"
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
  # push, a customer-authored yaml is normally empty. Only a hand-written
  # Type 1 server (its own server.ts) needs an mcp_servers entry.
  cat >&2 <<EOF
[start-connector] no $YAML_FILE — creating a minimal starter.
Only a legacy hand-written Type 1 MCP needs a yaml entry; edit this file if
you have one. Otherwise leave it alone — bundled + customer-mcps/
auto-discovery covers every setup.
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
# The connector needs CONNECTOR_KEY_FILE in its process env — the only
# required var since DB-TO-FILE. The sealed config store is a file under
# CONNECTOR_STATE_DIR, defaulted per-port below.
# Order:
#   1. .env at repo root (optional) — sourced if present. Lets devs override
#      the auto-provisioned defaults or wire in additional vars.
#   2. Auto-provisioned defaults for anything still unset:
#      - CONNECTOR_KEY_FILE → .local/master.key (auto-minted if missing)
# No .env template to copy, no manual pre-boot step. First-run on a fresh
# clone works.
if [ -f "$ENV_FILE" ]; then
  echo "[start-connector] sourcing $ENV_FILE (optional override)"
  set -a; source "$ENV_FILE"; set +a
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

# Drop-in MCP dir: in dev we point at customer-mcps/ so tools/*.ts folders
# get auto-discovered by the connector (W-A1/A2 of MCP-LOADING). Production
# images use the customer-mount path /var/lib/mcp-connector/customer-mcps/.
# Don't clobber a user-supplied value.
# MCP-AUDIT #31: the drop-in scanner refuses a folder that resolves outside
# MCP_DROPIN_DIR, so a symlink committed into a read-only production mount can't
# point discovery at a writable path. The documented dev workflow does exactly
# that on purpose — customer-mcps/<name> symlinks to examples/demos/<name> — so
# dev opts out here. Never set this in a deployed container.
export MCP_DROPIN_ALLOW_SYMLINK_ESCAPE=1

if [ -z "${MCP_DROPIN_DIR:-}" ]; then
  export MCP_DROPIN_DIR="$ROOT/customer-mcps"
  echo "[start-connector] MCP_DROPIN_DIR=$MCP_DROPIN_DIR"
fi

# Bundled MCP dir: in dev we point at bundled-mcps/ so Twilio-shipped MCPs
# (agentic-memory) get auto-discovered. Production
# images bake this to /app/bundled-mcps via the Dockerfile's ENV directive.
# D1 (always on) — no allowlist, no gate; every folder here registers.
if [ -z "${MCP_BUNDLED_DIR:-}" ]; then
  export MCP_BUNDLED_DIR="$ROOT/bundled-mcps"
  echo "[start-connector] MCP_BUNDLED_DIR=$MCP_BUNDLED_DIR"
fi

# ─── Port-derived instance env (applied here, AFTER .env sourcing) ─────────
# INSPECTOR_PORT and MCP_BASE_PORT: CLI arg always wins over .env — multi-
# instance mode needs these locked to the port arg. CONNECTOR_STATE_DIR is
# .env-overrideable via ${VAR:-default} so a dev can pin an explicit path.
#
# One state dir per port, which is the job POSTGRES_SCHEMA used to do: each
# instance gets its own tunnel identity instead of fighting over one row.
# Unlike the schema naming there is no historical case to preserve — the
# per-port form applies to 9090 too, because no dev has a file-backed store
# from before this change.
#
# The default MUST be set here. The connector's own default is the production
# path /var/lib/mcp-connector, which an unprivileged dev user cannot create —
# that is a `mkdir EACCES` at boot, not a fallback.
#
# MCP_BASE_PORT spacing (100 per port) keeps drop-in child ports from
# initial collision under auto-probe.
export INSPECTOR_PORT="$PORT"
export MCP_BASE_PORT="$((7100 + (PORT - 9090) * 100))"
export CONNECTOR_STATE_DIR="${CONNECTOR_STATE_DIR:-$ROOT/.local/state-${PORT}}"
mkdir -p "$CONNECTOR_STATE_DIR"

echo "[start-connector] CONNECTOR_STATE_DIR=$CONNECTOR_STATE_DIR"
echo "[start-connector] port=$PORT inspector=http://localhost:$PORT"
echo "[start-connector] starting connector with CONNECTOR_CONFIG=$YAML_FILE"
CONNECTOR_CONFIG="$YAML_FILE" node "$CONNECTOR_BIN" start &

echo
echo "[start-connector] running. Ctrl-C to stop."
wait
