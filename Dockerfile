# Multi-stage build for the main-server only.
# The shim is NOT built into this image — shims run on customer-side machines.

# ── Stage 1: build ────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Install all workspace deps. Copy manifests first to maximize Docker cache hits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/shim/package.json ./packages/shim/
COPY packages/main-server/package.json ./packages/main-server/
COPY packages/client/package.json ./packages/client/
RUN npm install --no-audit --no-fund

# Build only the workspaces the main-server actually needs at runtime.
COPY packages/shared ./packages/shared
COPY packages/main-server ./packages/main-server
# main-server reads packages/client/index.html + app.js at runtime; shim source
# is not needed in the image. Skip packages/shim entirely to keep image small.
COPY packages/client ./packages/client
RUN npx tsc -b packages/shared packages/main-server

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Workspaces require the root manifest + each consumed package's manifest so
# Node's symlink resolution finds @mcp-shim/shared at runtime.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/main-server/package.json ./packages/main-server/package.json
COPY --from=build /app/packages/main-server/dist ./packages/main-server/dist
COPY --from=build /app/packages/client ./packages/client

# Fly's runtime sets PORT for us; the server already reads it.
EXPOSE 8080

CMD ["node", "packages/main-server/dist/index.js"]
