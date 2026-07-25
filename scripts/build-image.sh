#!/usr/bin/env bash
# Builds the connector OCI image. Multi-arch (amd64 + arm64) so it runs on
# Graviton and ARM Macs.
#
# Local-only build (loads single-arch into the local docker daemon):
#   ./scripts/build-image.sh
#
# Multi-arch build that pushes to a registry:
#   IMAGE=your-registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-mcp-connector:dev}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-}"

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required (Docker Desktop bundles it)." >&2
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
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$IMAGE" \
  -f connector/Dockerfile \
  $ACTION_FLAG \
  .
