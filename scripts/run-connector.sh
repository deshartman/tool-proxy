#!/usr/bin/env bash
# Boots the sample MCP server + connector for end-to-end testing.
#
# Required: an external controller reachable at the URL set in
# packages/connector/config/connector-a.yaml's tunnel.controller_url.
#
# Prereqs:
#   - npm install (from repo root)
#   - npm run build
#   - cp packages/connector/config/connector-a.yaml.example
#         packages/connector/config/connector-a.yaml   # then edit controller_url
#   - cp packages/connector/config/connector-a.env.example
#         packages/connector/config/connector-a.env

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[run-connector] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Sample MCP server (HTTP).
echo "[run-connector] starting sample-mcp-server on :7100..."
(PORT=7100 cd "$ROOT/packages/sample-mcp-server" && node dist/index.js) &
sleep 1

# 2. Connector.
ENV_FILE="$ROOT/packages/connector/config/connector-a.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[run-connector] missing $ENV_FILE — copy from connector-a.env.example" >&2
  exit 1
fi
echo "[run-connector] starting connector..."
(set -a; source "$ENV_FILE"; set +a; \
  cd "$ROOT/packages/connector" && node dist/index.js) &

echo
echo "[run-connector] running. Ctrl-C to stop."
wait
