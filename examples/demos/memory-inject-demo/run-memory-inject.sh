#!/usr/bin/env bash
# Thin wrapper around invoke.mjs — see README.md for setup + usage.
# Forwards all args, so both usage modes still work:
#   ./run-memory-inject.sh
#   ./run-memory-inject.sh --channel=sms --value=+1... --event="..."

set -euo pipefail

cd "$(dirname "$0")"
exec node invoke.mjs "$@"
