#!/usr/bin/env bash
# Dev-mode launcher for the BUNDLE_DEV_OVERRIDE_ENTERPRISE_KNOWLEDGE flow.
#
# Activates the local venv (created by `uv venv .venv` + `uv pip install
# -e .`) and execs the bundle's entrypoint over stdio. Used when iterating
# on this bundle against a running mcp-shim connector — see README.md
# §"Running under the connector (dev override)".
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/.venv/bin/customer-ek-mcp" "$@"
