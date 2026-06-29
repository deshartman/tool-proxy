#!/usr/bin/env bash
# Restore a snapshot written by snapshot-crm.sh. Defaults to crm-latest.tar.gz;
# pass an explicit tarball path as $1 to pick a specific snapshot.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT/.local-backups"
ARCHIVE="${1:-$BACKUP_DIR/crm-latest.tar.gz}"

if [ ! -f "$ARCHIVE" ]; then
  echo "restore-crm: archive not found: $ARCHIVE" >&2
  exit 1
fi

cd "$ROOT"
tar -xzf "$ARCHIVE"
echo "restore-crm: extracted $ARCHIVE"
