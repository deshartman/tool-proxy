#!/usr/bin/env bash
# Snapshot the gitignored dev scaffolding (mcp/local/crm/ + mock/customers/data.ts)
# into a timestamped tarball under .local-backups/. Pair with restore-crm.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT/.local-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/crm-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
cd "$ROOT"

PATHS=()
[ -d mcp/local/crm ] && PATHS+=(mcp/local/crm)
[ -f mock/customers/data.ts ] && PATHS+=(mock/customers/data.ts)

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "snapshot-crm: nothing to snapshot (mcp/local/crm/ and mock/customers/data.ts both missing)" >&2
  exit 1
fi

tar -czf "$OUT" "${PATHS[@]}"
ln -sf "crm-$STAMP.tar.gz" "$BACKUP_DIR/crm-latest.tar.gz"
echo "snapshot-crm: wrote $OUT"
echo "snapshot-crm: 'latest' symlink → $BACKUP_DIR/crm-latest.tar.gz"
