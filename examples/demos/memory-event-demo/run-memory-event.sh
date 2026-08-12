#!/usr/bin/env bash
# Thin wrapper around invoke.mjs — see README.md for setup + usage.
# One mode = one tool call. Forwards all args:
#   ./run-memory-event.sh --list                      [--match --channel --limit]
#   ./run-memory-event.sh --find    --identifier=+1... --channel=phone
#   ./run-memory-event.sh --inject  --agentId=agt_123 --identityId=identity_... --event="..."

set -euo pipefail

cd "$(dirname "$0")"
exec node invoke.mjs "$@"
