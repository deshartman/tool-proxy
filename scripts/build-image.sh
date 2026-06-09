#!/usr/bin/env bash
# Builds the connector OCI image. Multi-arch (amd64 + arm64) so it runs on
# Graviton and ARM Macs.
#
# Local-only build (loads single-arch into the local docker daemon):
#   ./scripts/build-image.sh
#
# Multi-arch build that pushes to a registry:
#   IMAGE=your-registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh
#
# Bundle source (Type 3 MCPs) lives in the sibling repo `mcp-shim-bundled/`.
# The Dockerfile pulls it via a named build context (`bundles`) so the
# main build context stays the connector repo. Override the bundle source
# location with BUNDLES_DIR (default: ../mcp-shim-bundled relative to
# this repo) — useful for CI or when the sibling lives at a non-standard
# path.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-mcp-connector:dev}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-}"
BUNDLES_DIR="${BUNDLES_DIR:-$ROOT/../mcp-shim-bundled}"

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required (Docker Desktop bundles it)." >&2
  exit 1
fi

if [ ! -d "$BUNDLES_DIR" ]; then
  echo "[build-image] BUNDLES_DIR=$BUNDLES_DIR does not exist." >&2
  echo "  The Dockerfile expects the sibling bundle repo at this path." >&2
  echo "  Set BUNDLES_DIR=/abs/path/to/mcp-shim-bundled to override." >&2
  exit 1
fi

cd "$ROOT"

# buildx doesn't allow --load with multi-arch; pick a sensible default.
ACTION_FLAG="--load"
if [ -n "$PUSH" ]; then
  ACTION_FLAG="--push"
elif [[ "$PLATFORMS" == *","* ]]; then
  echo "[build-image] multi-arch without PUSH=1 — keeping in build cache only (no --load)"
  ACTION_FLAG=""
fi

echo "[build-image] image=$IMAGE platforms=$PLATFORMS action=${ACTION_FLAG:-cache-only}"
echo "[build-image] bundles=$BUNDLES_DIR"
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$IMAGE" \
  -f packages/connector/Dockerfile \
  --build-context "bundles=$BUNDLES_DIR" \
  $ACTION_FLAG \
  .
