#!/usr/bin/env bash
# Thin wrapper around invoke-federated.mjs — see README.md "Testing federated
# mode". Forwards all args:
#   ./run-federated.sh --port=9091
#   ./run-federated.sh --port=9091 --token=<real-idp-jwt>

set -euo pipefail

cd "$(dirname "$0")"
exec node invoke-federated.mjs "$@"
