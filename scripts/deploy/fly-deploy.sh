#!/usr/bin/env bash
# Self-contained Fly.io deploy for mcp-connector.
#
# Runs from a fresh clone:
#   1. Preflight: fly CLI on PATH, deploy/fly/fly.toml present
#   2. `npm install` if node_modules is missing
#   3. `npm run build` — incremental (tsc -b), no-op when already fresh
#   4. `mcp-connector deploy apply --target fly` — the four idempotent Fly ops
#      (apps create, secrets set CONNECTOR_KEY_B64, volumes create state,
#      fly deploy). Was five: `postgres create` + `attach` went away with
#      DB-TO-FILE, and with them the only non-idempotent step.
#
# Local flags:
#   ./scripts/deploy/fly-deploy.sh --skip-build     # if you know dist is fresh
#   ./scripts/deploy/fly-deploy.sh --redeploy-only  # skip the 4-op bootstrap;
#                                                   # just run `fly deploy`.
#                                                   # Used by CI (see
#                                                   # .github/workflows/deploy-main.yml)
#                                                   # because Fly deploy tokens
#                                                   # are app-scoped and can't
#                                                   # create org-level resources
#                                                   # (volumes, secrets).
#                                                   # The 3 bootstrap ops are
#                                                   # idempotent + one-time —
#                                                   # once done locally, CI
#                                                   # only needs to redeploy.
#
# `deploy apply` is non-interactive by design — no prompt flags to pass through.
# For a first-time setup you need `deploy init` first (which does take --yes);
# see the runbook at deploy/fly/OPERATOR-RUNBOOK.md.
#
# Prereqs (one-time, out of scope for this script):
#   - flyctl installed and `fly auth login`ed to your Fly org
#   - deploy/fly/fly.toml already generated via `mcp-connector deploy init`
#     (see deploy/fly/OPERATOR-RUNBOOK.md for the init step)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ── Preflights ─────────────────────────────────────────────────────────────
if ! command -v fly >/dev/null 2>&1; then
  echo "[fly-deploy] error: fly CLI not on PATH" >&2
  echo "[fly-deploy] install: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if [[ ! -f deploy/fly/fly.toml ]]; then
  echo "[fly-deploy] error: deploy/fly/fly.toml missing" >&2
  echo "[fly-deploy] run this first (from repo root):" >&2
  echo "[fly-deploy]   node connector/dist/index.js deploy init --target fly \\" >&2
  echo "[fly-deploy]     --name <CUSTOMER-NAME> --controller-url <https://...>" >&2
  echo "[fly-deploy] see deploy/fly/OPERATOR-RUNBOOK.md for the full flow." >&2
  exit 1
fi

# ── Parse local flags; pass anything else through to `deploy apply` ────────
SKIP_BUILD=0
REDEPLOY_ONLY=0
FILTERED_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --redeploy-only)
      REDEPLOY_ONLY=1
      ;;
    *)
      FILTERED_ARGS+=("$arg")
      ;;
  esac
done

# ── Install deps if missing ────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  echo "[fly-deploy] installing dependencies (first-run)..."
  npm install
fi

# ── Build (incremental — fast when fresh) ──────────────────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "[fly-deploy] building connector..."
  npm run build
else
  echo "[fly-deploy] --skip-build set; assuming connector/dist/ is fresh"
fi

if [[ ! -f connector/dist/index.js ]]; then
  echo "[fly-deploy] error: connector/dist/index.js missing after build" >&2
  echo "[fly-deploy] run 'npm run build' from repo root and inspect the output." >&2
  exit 1
fi

# ── Fire ───────────────────────────────────────────────────────────────────
# --redeploy-only shortcut: skip the 3 bootstrap ops (apps create, secrets set,
# volumes create — all one-time, all org-permission-heavy) and just run step
# [4/4] of `deploy apply` verbatim.
# This is the CI path — app-scoped Fly deploy tokens can't touch org-level
# resources, but they CAN run `fly deploy` on the target app.
# See the `---- 4. Deploy ----` block in connector/src/deploy/apply.ts for the
# reference invocation (named, not line-numbered — the line moved once already)
# — we mirror it exactly (CWD=repo-root, -c deploy/fly/fly.toml).
if [[ $REDEPLOY_ONLY -eq 1 ]]; then
  if [[ ! -x "$(command -v fly)" ]]; then
    echo "[fly-deploy] error: fly CLI not on PATH (needed for --redeploy-only)" >&2
    exit 1
  fi
  echo "[fly-deploy] --redeploy-only: running fly deploy directly (skipping bootstrap)"
  exec fly deploy -c deploy/fly/fly.toml
fi

# Empty-array quoting under `set -u` — `"${arr[@]:-}"` expands to a literal
# empty string that Node's parseArgs then sees as an unexpected positional.
# Branch on array length instead.
if [[ ${#FILTERED_ARGS[@]} -gt 0 ]]; then
  echo "[fly-deploy] running: mcp-connector deploy apply --target fly ${FILTERED_ARGS[*]}"
  exec node connector/dist/index.js deploy apply --target fly "${FILTERED_ARGS[@]}"
else
  echo "[fly-deploy] running: mcp-connector deploy apply --target fly"
  exec node connector/dist/index.js deploy apply --target fly
fi
