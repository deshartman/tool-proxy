# Multi-stage build. Stage 1 installs workspace deps + per-example deps and
# compiles the connector's TypeScript; stage 2 ships only the runtime bits.
#
# What ends up in the runtime image:
#   - the connector's compiled JS + its prod node_modules (incl. tsx)
#   - the inspector UI assets
#   - examples/* trees so Type 1 entries in connector.yaml can spawn from
#     them. tools/*.ts files are read at runtime by tsx (no build per
#     example).
#
# In production, the customer mounts their own connector.yaml at
# CONNECTOR_CONFIG and supplies env via container env. dir: paths in that
# yaml are resolved against the yaml file's directory.

# ── Build stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo

# Workspace install for the connector. Examples live outside the workspace
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

# Per-example deps (e.g. twilio's SDK). Each examples/* with its own
# package.json gets its own node_modules so deps don't leak across MCPs and
# the workspace install graph stays clean.
COPY examples examples
RUN set -e; \
    for dir in examples/*/; do \
      [ -f "$dir/package.json" ] || continue; \
      depcount=$(node -e \
        "console.log(Object.keys(require('./$dir/package.json').dependencies||{}).length)"); \
      if [ "$depcount" != "0" ]; then \
        echo "installing deps in $dir"; \
        (cd "$dir" && npm install --omit=dev --no-package-lock); \
      fi; \
    done

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Connector + its prod deps (incl. tsx, which the spawner needs to run
# Type 1 children).
COPY --from=build /repo/node_modules                     ./node_modules
COPY --from=build /repo/packages/connector/node_modules  ./packages/connector/node_modules
COPY --from=build /repo/packages/connector/dist          ./packages/connector/dist
COPY --from=build /repo/packages/connector/public        ./packages/connector/public
COPY --from=build /repo/packages/connector/package.json  ./packages/connector/package.json
COPY --from=build /repo/package.json                     ./package.json

# Examples. Required so Type 1 entries in connector.yaml can spawn from
# /app/examples/<name>/server.ts. Customers extending the image with their
# own MCPs can drop additional folders in here.
COPY --from=build /repo/examples ./examples

WORKDIR /app/packages/connector

# Default config location — mount the customer's yaml at this path. dir:
# entries inside the yaml are resolved relative to the yaml's directory,
# so a yaml at /etc/mcp-connector/config.yaml referencing
# dir: /app/examples/sample-mcp-server works.
ENV CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml

EXPOSE 9090
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
