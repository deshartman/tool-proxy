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

# C8 (security hardening) — assemble POSTGRES_URL from a mounted secret
# file so the password never lives in a compose YAML string or a .env
# entry. The compose file sets:
#   POSTGRES_URL_TEMPLATE=postgres://mcp:__PWFILE__@postgres:5432/mcp_connector
#   POSTGRES_PW_FILE=/run/secrets/pg_password
# The template is expanded once, then the template vars are unset so
# the child process doesn't inherit them. Deployments that set
# POSTGRES_URL directly (Fly, RDS, managed Postgres) bypass this block.
if [ -n "${POSTGRES_URL_TEMPLATE:-}" ] && [ -n "${POSTGRES_PW_FILE:-}" ] && [ -f "$POSTGRES_PW_FILE" ]; then
  pw=$(cat "$POSTGRES_PW_FILE")
  # MCP-AUDIT #12: built with prefix/suffix parameter expansion, NOT sed. The
  # previous `sed "s|__PWFILE__|$pw|"` broke on two characters: `&` is the
  # replacement-side metacharacter meaning "the whole match", so a password
  # `a&b` expanded to `a__PWFILE__b`; and a `|` in the password terminated the
  # expression outright. Both failed as a bare authentication error with no hint
  # at the cause. It also put the password in sed's argv, visible to `ps` inside
  # the container. Expansion is literal, needs no escaping, and spawns nothing.
  prefix=${POSTGRES_URL_TEMPLATE%%__PWFILE__*}
  suffix=${POSTGRES_URL_TEMPLATE#*__PWFILE__}
  export POSTGRES_URL="${prefix}${pw}${suffix}"
  unset pw prefix suffix POSTGRES_URL_TEMPLATE POSTGRES_PW_FILE
fi

exec su-exec mcp:mcp node dist/index.js "$@"
