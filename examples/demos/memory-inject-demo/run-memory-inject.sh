#!/usr/bin/env bash
# Thin wrapper around invoke.mjs — see README.md for setup + usage.
# One mode = one API call. Forwards all args:
#   ./run-memory-inject.sh --list                      [--identifier --channel --limit --timeoutMs]
#   ./run-memory-inject.sh --inject  --agentId=agt_123 --identityId=identity_... --event="..."

set -euo pipefail

cd "$(dirname "$0")"
exec node invoke.mjs "$@"
