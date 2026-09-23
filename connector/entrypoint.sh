#!/bin/sh
# mcp-connector runtime entrypoint.
#
# On platforms whose secret store is env-only (Fly.io, Azure Container Apps,
# any KMS-as-env shape), the 32-byte master key arrives as $CONNECTOR_KEY_B64.
# This script decodes it into $CONNECTOR_KEY_FILE at boot.
#
# On platforms that mount the key file directly (docker-compose.prod.yml,
# Kubernetes Secret volume, hand-provisioned VM), $CONNECTOR_KEY_B64 is
# unset and this script is a no-op — the mounted file is used as-is.
#
# See CODE-DEPLOY design record §"D2 — Master key delivery" for
# the design record.

set -eu

key_file="${CONNECTOR_KEY_FILE:-/etc/mcp-connector/connector.key}"

if [ -n "${CONNECTOR_KEY_B64:-}" ]; then
  mkdir -p "$(dirname "$key_file")"
  printf '%s' "$CONNECTOR_KEY_B64" | base64 -d > "$key_file"
  chown mcp:mcp "$key_file"
  chmod 400 "$key_file"
  unset CONNECTOR_KEY_B64
fi

# Re-establish what the connector needs ON the state volume, while we are
# still root and before the su-exec below drops to mcp.
#
# The Dockerfile already does `mkdir -p /var/lib/mcp-connector/customer-mcps`
# and `chown -R mcp:mcp /var/lib/mcp-connector` — but a volume mounted AT that
# path SHADOWS the image directory, so none of it survives. Fly mounts the
# volume `uid: 0, gid: 0, chmod 0755`; a K8s PVC and a raw EFS mount behave the
# same way. (A docker-compose *named* volume is the exception — Docker seeds it
# from the image and keeps ownership — which is why this only bites on the
# cloud targets.) The connector then runs as mcp against a root-owned 0755
# directory and cannot create anything in it.
#
#   agentic-memory/ — the bundled MCP writes .state.json here via a sibling
#                     .tmp + rename, so mcp must own the DIRECTORY, not just
#                     the file. Failure mode is a lazy EACCES on the first
#                     memory write, long after a clean boot.
#   customer-mcps/  — default root for the drop-in scanner. Created so
#                     discovery (and the "Refresh local MCPs" rescan) sees an
#                     empty directory instead of a missing path.
#   state/          — holds config.json, the sealed config store (DB-TO-FILE).
#                     Same reason as agentic-memory: ConfigStore writes a
#                     sibling .tmp and renames, so mcp must own the DIRECTORY.
#                     This one fails at BOOT rather than lazily — ConfigStore
#                     .open() writes the initial document immediately — so a
#                     missing chown here is a crash-loop, not a late surprise.
#                     It is why the store defaults to a subdirectory at all
#                     (see DEFAULT_STATE_DIR in src/config-store/store-file.ts):
#                     the volume root below stays root-owned on purpose.
#
# Deliberately NOT `chown -R` on the volume root. The root stays root-owned so
# a compromised child cannot litter the volume or plant a drop-in for the next
# boot, and a customer's read-only bind-mount of customer-mcps/ must not be
# rewritten. Both commands are therefore tolerant: on a read-only mount they
# warn and boot continues, because a pre-provisioned mount is a valid setup.
state_dir="/var/lib/mcp-connector"
if [ -d "$state_dir" ]; then
  for d in agentic-memory customer-mcps state; do
    if [ ! -d "$state_dir/$d" ]; then
      mkdir -p "$state_dir/$d" 2>/dev/null \
        || echo "[entrypoint] warn: cannot create $state_dir/$d (read-only mount?)" >&2
    fi
    if [ -d "$state_dir/$d" ]; then
      chown mcp:mcp "$state_dir/$d" 2>/dev/null \
        || echo "[entrypoint] warn: cannot chown $state_dir/$d (read-only mount?)" >&2
    fi
  done
fi

exec su-exec mcp:mcp node dist/index.js "$@"
