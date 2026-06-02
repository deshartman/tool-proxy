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

# Kill prior runs of THIS SCRIPT (children come down via the trap).
echo "[run-local] cleaning up any prior runs of this script..."
SELF_PID=$$
for pid in $(pgrep -f 'scripts/run-local\.sh' 2>/dev/null); do
  [ "$pid" = "$SELF_PID" ] && continue
  echo "  killing prior run pid $pid"
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 1

echo "[run-local] starting local-controller on :9090..."
(cd "$ROOT/packages/local-controller" && PORT=9090 node dist/index.js) &
sleep 1

echo "[run-local] starting sample-mcp-server on :7100..."
(cd "$ROOT/packages/sample-mcp-server" && PORT=7100 node dist/index.js) &
sleep 1

# Use the example config if a real one isn't present yet — keeps the
# default flow zero-config for first-run.
if [ ! -f "$ROOT/packages/connector/config/connector-a.yaml" ]; then
  cp "$ROOT/packages/connector/config/connector-a.yaml.example" \
     "$ROOT/packages/connector/config/connector-a.yaml"
  echo "[run-local] created connector-a.yaml from example"
fi

echo "[run-local] starting connector (inspector on :9091; controller already on :9090)..."
(cd "$ROOT/packages/connector" && \
  CONNECTOR_CONFIG=config/connector-a.yaml INSPECTOR_PORT=9091 node dist/index.js) &

echo
echo "[run-local] all up. Open:"
echo "  controller UI: http://localhost:9090/"
echo "  inspector UI:  http://localhost:9091/"
echo "[run-local] Ctrl-C to stop."
wait
