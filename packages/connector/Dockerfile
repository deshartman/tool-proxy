# Multi-stage build. Stages:
#   1. node-build      — workspace install + connector TS compile + per-MCP npm deps
#   2. bundle-build    — Python venv per Type 3 bundle (installs from `bundles` build context)
#   3. runtime         — final image with connector dist + mcp/ tree + bundle venvs
#
# What ends up in the runtime image:
#   - the connector's compiled JS + its prod node_modules (incl. tsx)
#   - the inspector UI assets
#   - mcp/local/* trees so Type 1 entries in connector.yaml can spawn from
#     them. tools/*.ts files are read at runtime by tsx (no build per
#     MCP).
#   - mcp/external/* + mcp/bundled/* trees for Type 2/3 .env stubs. The
#     yaml's dir: points here so per-entry .env loading works.
#   - /opt/bundled-mcps/<name>/.venv/ — one venv per Type 3 bundle
#     registered in BUNDLED_MCPS (see packages/connector/src/config.ts).
#     Sourced from the `bundles` build context (sibling `mcp-shim-bundled/`
#     repo); see scripts/build-image.sh for how it's wired.
#
# In production, the customer mounts their own connector.yaml at
# CONNECTOR_CONFIG and supplies env via container env. dir: paths in that
# yaml are resolved against the yaml file's directory.

# ── Node build stage ───────────────────────────────────────────────────────
FROM node:22-alpine AS node-build
WORKDIR /repo

# Workspace install for the connector. MCP folders live outside the workspace
# graph (per CLAUDE.md) — their deps install in a separate step below so
# their node_modules don't bloat the connector layer.
COPY package.json package-lock.json ./
COPY packages/connector/package.json packages/connector/

RUN npm ci --workspaces --include-workspace-root

# Now the source.
COPY tsconfig.base.json ./
COPY packages/connector packages/connector

RUN npm run build

# Strip workspace dev deps for the runtime copy.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# MCP tree: Type 1 source folders (mcp/local/), Type 2 .env stubs
# (mcp/external/), Type 3 .env stubs (mcp/bundled/). Per-entry deps install
# below for any folder that carries its own package.json so deps don't leak
# across MCPs and the workspace install graph stays clean.
COPY mcp mcp
RUN set -e; \
    for dir in mcp/local/*/ mcp/external/*/; do \
      [ -f "$dir/package.json" ] || continue; \
      depcount=$(node -e \
        "console.log(Object.keys(require('./$dir/package.json').dependencies||{}).length)"); \
      if [ "$depcount" != "0" ]; then \
        echo "installing deps in $dir"; \
        (cd "$dir" && npm install --omit=dev --no-package-lock); \
      fi; \
    done

# ── Bundle build stage ─────────────────────────────────────────────────────
# Installs each Type 3 bundle into its own venv. Today only
# `enterprise-knowledge` is registered in BUNDLED_MCPS; add new bundles by
# duplicating the venv-build pattern below and registering the bundle in
# packages/connector/src/config.ts.
#
# The `bundles` build context maps to the sibling `mcp-shim-bundled/` repo
# (see scripts/build-image.sh). When PyPI publishing lands, swap
# `pip install <local-path>` for `pip install <pkg>==<version>` and drop
# this stage's dependency on the source tree — the venv path stays the
# same, so config.ts and the runtime stage are unaffected.
#
# Alpine + python3 works for step 2's stub backend (deps: mcp, pydantic).
# Step 4 (real LlamaIndex backend) brings native deps (psycopg, chromadb)
# that prefer glibc — switch this stage's base to a glibc image
# (python:3.12-slim) when LlamaIndex lands. The connector stage stays
# Alpine; only this stage's base needs to change.
FROM python:3.12-alpine AS bundle-build
WORKDIR /opt/bundled-mcps

# enterprise-knowledge — sourced from the `bundles` build context. The
# entrypoint `customer-ek-mcp` is declared in the bundle's pyproject.toml;
# `python -m venv` + `pip install <path>` lays it down at the venv's
# bin/customer-ek-mcp, which is what BUNDLED_MCPS["enterprise-knowledge"]
# points at.
RUN --mount=type=bind,from=bundles,source=enterprise-knowledge,target=/bundle-src \
    python -m venv --copies /opt/bundled-mcps/enterprise-knowledge/.venv \
 && /opt/bundled-mcps/enterprise-knowledge/.venv/bin/pip install --no-cache-dir /bundle-src
# `--copies` makes the venv's bin/python a real binary instead of a
# symlink to /usr/local/bin/python. The runtime stage uses Alpine's
# `apk add python3` (different Python prefix), so symlinked venvs
# would dangle when copied across.

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Python is the runtime for Type 3 Python bundles. Alpine's python3
# package brings the interpreter the venv shebangs need; pip is not
# required at runtime (bundles are pre-installed in their venvs by the
# bundle-build stage).
RUN apk add --no-cache python3

# Connector + its prod deps (incl. tsx, which the spawner needs to run
# Type 1 children). npm workspaces hoist all deps to the root node_modules,
# so there is no per-package packages/connector/node_modules to copy —
# Node's resolver finds them via the parent dir walk.
COPY --from=node-build /repo/node_modules                     ./node_modules
COPY --from=node-build /repo/packages/connector/dist          ./packages/connector/dist
COPY --from=node-build /repo/packages/connector/public        ./packages/connector/public
COPY --from=node-build /repo/packages/connector/package.json  ./packages/connector/package.json
COPY --from=node-build /repo/package.json                     ./package.json

# MCP tree: Type 1 source (mcp/local/), Type 2 .env stubs (mcp/external/),
# Type 3 .env stubs (mcp/bundled/). Required so the customer's yaml can
# resolve dir: paths to /app/mcp/local/<name>/ for Type 1 spawning and
# /app/mcp/{external,bundled}/<name>/ for per-entry .env merging.
# Customers extending the image with their own MCPs can drop additional
# folders under mcp/local/.
COPY --from=node-build /repo/mcp ./mcp

# Bundle venvs — one directory per Type 3 bundle registered in
# BUNDLED_MCPS. The connector spawns each via stdio at the path baked
# into BUNDLED_MCPS (config.ts). Adding a new bundle: drop a new
# `RUN python -m venv ...` in bundle-build, register in BUNDLED_MCPS,
# rebuild.
COPY --from=bundle-build /opt/bundled-mcps /opt/bundled-mcps

WORKDIR /app/packages/connector

# Default config location — mount the customer's yaml at this path. dir:
# entries inside the yaml are resolved relative to the yaml's directory,
# so a yaml at /etc/mcp-connector/config.yaml referencing
# dir: /app/mcp/local/sample works.
ENV CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml

EXPOSE 9090
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
