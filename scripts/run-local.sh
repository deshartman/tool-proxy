#!/usr/bin/env bash
# Fully-local rig: controller UI + sample MCP server + connector.
# Open http://localhost:9090/ in a browser once it's up.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo
  echo "[run-local] shutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[run-local] starting local-controller on :9090..."
(PORT=9090 cd "$ROOT/packages/local-controller" && node dist/index.js) &
sleep 1

echo "[run-local] starting sample-mcp-server on :7100..."
(PORT=7100 cd "$ROOT/packages/sample-mcp-server" && node dist/index.js) &
sleep 1

# Use the example config if a real one isn't present yet — keeps the
# default flow zero-config for first-run.
if [ ! -f "$ROOT/packages/connector/config/connector-a.yaml" ]; then
  cp "$ROOT/packages/connector/config/connector-a.yaml.example" \
     "$ROOT/packages/connector/config/connector-a.yaml"
  echo "[run-local] created connector-a.yaml from example"
fi

echo "[run-local] starting connector..."
(cd "$ROOT/packages/connector" && \
  CONNECTOR_CONFIG=config/connector-a.yaml node dist/index.js) &

echo
echo "[run-local] all up. Open: http://localhost:9090/"
echo "[run-local] Ctrl-C to stop."
wait
