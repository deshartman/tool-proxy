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
#   - mcp/bundled/* tree for Type 3 .env stubs. The yaml's dir: points here
#     so per-entry .env loading works. Type 2 (3rd-party) MCPs come from the
#     controller UI per docs/MCP-PROTOCOL.md v1.1, not from yaml/disk.
#   - /opt/bundled-mcps/<name>/.venv/ — one venv per Type 3 bundle
#     registered in BUNDLED_MCPS (see connector/src/config.ts).
#     Source lives in-tree at mcp/bundled/<name>/ and is installed by the
#     bundle-build stage below.
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
COPY connector/package.json connector/

RUN npm ci --workspaces --include-workspace-root

# Now the source.
COPY tsconfig.base.json ./
COPY connector connector

# Repo-root template files the postbuild script propagates into the package
# so `mcp-connector init` can read them via `import.meta.url` post-`npm i`.
# Not in the working-tree build path (files are already there); required for
# the isolated build context inside this image.
COPY .env.example connector.yaml.example ./

RUN npm run build

# Strip workspace dev deps for the runtime copy.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# MCP tree: Type 1 source folders (mcp/local/) + Type 3 .env stubs
# (mcp/bundled/). Per-entry deps install below for any folder that carries
# its own package.json so deps don't leak across MCPs and the workspace
# install graph stays clean. Type 2 (3rd-party) MCPs come from the controller
# UI per docs/MCP-PROTOCOL.md v1.1 — they have no on-disk presence.
COPY mcp mcp

# Type 3 bundle source. Lives outside mcp/ deliberately — bundle source is a
# build input (read by pip), not a runtime artifact (the connector spawns
# from /opt/bundled-mcps/<name>/.venv/, populated in bundle-build below).
# Keeping it under bundles/ here means the runtime stage's `COPY mcp` doesn't
# carry pyproject.toml + src/ + migrations/ as dead weight.
COPY bundles bundles

RUN set -e; \
    for dir in mcp/local/*/ mcp/bundled/*/; do \
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
# connector/src/config.ts.
#
# Bundle source comes from the in-tree `mcp/bundled/<name>/` folder — the
# node-build stage already copied `mcp/` so we mount it via `--from=node-build`.
#
# Alpine + python3 works for the stub backend (deps: mcp, pydantic).
# When LlamaIndex lands (real backend) it brings native deps (psycopg,
# chromadb) that prefer glibc — switch this stage's base to a glibc image
# (python:3.12-slim) at that point. The connector stage stays Alpine; only
# this stage's base needs to change.
FROM python:3.12-alpine AS bundle-build
WORKDIR /opt/bundled-mcps

# enterprise-knowledge — installed from mcp/bundled/enterprise-knowledge/.
# The entrypoint `customer-ek-mcp` is declared in the bundle's pyproject.toml;
# `python -m venv` + `pip install <path>` lays it down at the venv's
# bin/customer-ek-mcp, which is what BUNDLED_MCPS["enterprise-knowledge"]
# in config.ts points at.
RUN --mount=type=bind,from=node-build,source=/repo/bundles/enterprise-knowledge,target=/bundle-src \
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
# Type 1 children). npm workspaces hoist MOST deps to the root node_modules
# — but some resolve into the workspace-nested connector/node_modules
# when a version conflict prevents hoisting (npm's isolation-by-nesting).
# `dotenv@^17` is the canonical example today. Copy the nested tree so
# Node's parent-dir walk finds those deps too.
COPY --from=node-build /repo/node_modules                          ./node_modules
COPY --from=node-build /repo/connector/node_modules       ./connector/node_modules
COPY --from=node-build /repo/connector/dist               ./connector/dist
COPY --from=node-build /repo/connector/public             ./connector/public
COPY --from=node-build /repo/connector/package.json       ./connector/package.json
COPY --from=node-build /repo/package.json                          ./package.json

# MCP tree: Type 1 source (mcp/local/) + Type 3 .env stubs (mcp/bundled/).
# Required so the customer's yaml can resolve dir: paths to
# /app/mcp/local/<name>/ for Type 1 spawning and /app/mcp/bundled/<name>/
# for per-entry .env merging. Type 2 (3rd-party) MCPs come from the
# controller UI per docs/MCP-PROTOCOL.md v1.1 — no on-disk presence.
# Customers extending the image with their own MCPs can drop additional
# folders under mcp/local/.
COPY --from=node-build /repo/mcp ./mcp

# Bundle venvs — one directory per Type 3 bundle registered in
# BUNDLED_MCPS. The connector spawns each via stdio at the path baked
# into BUNDLED_MCPS (config.ts). Adding a new bundle: drop a new
# `RUN python -m venv ...` in bundle-build, register in BUNDLED_MCPS,
# rebuild.
COPY --from=bundle-build /opt/bundled-mcps /opt/bundled-mcps

# Runtime entrypoint — decodes $CONNECTOR_KEY_B64 → $CONNECTOR_KEY_FILE on
# platforms whose secret store is env-only (Fly.io, ACA, etc.); no-op when
# the env is unset (docker-compose et al. that mount the file directly).
# See architectural-plans/CODE-DEPLOY.md §"D2 — Master key delivery".
COPY connector/entrypoint.sh /usr/local/bin/mcp-connector-entrypoint.sh
RUN chmod +x /usr/local/bin/mcp-connector-entrypoint.sh

WORKDIR /app/connector

# Default config location — mount the customer's yaml at this path. dir:
# entries inside the yaml are resolved relative to the yaml's directory,
# so a yaml at /etc/mcp-connector/config.yaml referencing
# dir: /app/mcp/local/sample works.
ENV CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml
# Default master-key location — matches the path the entrypoint script
# writes to when $CONNECTOR_KEY_B64 is set (Fly.io / ACA / any secret-as-env
# platform). Override at deploy time if the operator mounts a key file
# somewhere else. Symmetric with CONNECTOR_CONFIG above; without this ENV
# the connector's env-loader fails with "CONNECTOR_KEY_FILE is required"
# even though the entrypoint just wrote the key to the default path.
ENV CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key

EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/mcp-connector-entrypoint.sh"]
CMD ["start"]
