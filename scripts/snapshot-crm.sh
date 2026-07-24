#!/usr/bin/env bash
# Snapshot the gitignored dev scaffolding (customer-mcps/crm/ + examples/mock-backend/data.ts)
# into a timestamped tarball under .local-backups/. Pair with restore-crm.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT/.local-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/crm-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
cd "$ROOT"

PATHS=()
[ -d customer-mcps/crm ] && PATHS+=(customer-mcps/crm)
[ -f examples/mock-backend/data.ts ] && PATHS+=(examples/mock-backend/data.ts)

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "snapshot-crm: nothing to snapshot (customer-mcps/crm/ and examples/mock-backend/data.ts both missing)" >&2
  exit 1
fi

tar -czf "$OUT" "${PATHS[@]}"
ln -sf "crm-$STAMP.tar.gz" "$BACKUP_DIR/crm-latest.tar.gz"
echo "snapshot-crm: wrote $OUT"
echo "snapshot-crm: 'latest' symlink → $BACKUP_DIR/crm-latest.tar.gz"
