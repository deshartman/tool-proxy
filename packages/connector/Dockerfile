# Multi-stage build. Stage 1 installs dev deps and compiles TypeScript;
# stage 2 ships only the compiled JS, prod deps, and the inspector UI assets.
# Result: ~150MB image instead of ~400MB.

# ── Build stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo

# Workspace install. Only @mcp-shim/connector is a workspace package now;
# the demo MCP servers under examples/ are standalone and not part of the
# image.
COPY package.json package-lock.json ./
COPY packages/connector/package.json packages/connector/

RUN npm ci --workspaces --include-workspace-root

# Now the source.
COPY tsconfig.base.json ./
COPY packages/connector packages/connector

RUN npm run build

# Strip dev deps for the runtime copy.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Minimal runtime layout — connector only.
COPY --from=build /repo/node_modules                     ./node_modules
COPY --from=build /repo/packages/connector/node_modules  ./packages/connector/node_modules
COPY --from=build /repo/packages/connector/dist          ./packages/connector/dist
COPY --from=build /repo/packages/connector/public        ./packages/connector/public
COPY --from=build /repo/packages/connector/package.json  ./packages/connector/package.json
COPY --from=build /repo/package.json                     ./package.json

# Default config location inside the container; mount the customer's YAML at
# this path. CONNECTOR_CONFIG is resolved relative to packages/connector/, so
# we pass the absolute path and skip the env var.
WORKDIR /app/packages/connector
ENV CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml

EXPOSE 9090
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
