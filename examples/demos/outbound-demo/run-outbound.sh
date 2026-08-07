#!/usr/bin/env bash
# Thin wrapper around invoke.mjs — see README.md for setup + usage.
# Forwards all args, so both usage modes still work:
#   ./run-outbound.sh
#   ./run-outbound.sh --to=+1... --agentId=... --channelId=...

set -euo pipefail

cd "$(dirname "$0")"
exec node invoke.mjs "$@"
