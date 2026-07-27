# Mock customer service — Postgres-backed CRM store.
# Built by Fly at deploy time; not published as a public image.

FROM node:22-alpine
WORKDIR /app

# Install deps first for cache-friendliness.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Explicit source COPYs — Fly's build context includes the repo root
# under `fly deploy --config examples/mock-backend/fly.toml`, and root
# .dockerignore rules can drop files a bare `COPY . .` would otherwise
# pick up. Listing the source files by name sidesteps both concerns and
# also fails loudly if a file is missing at build time.
COPY server.ts data.ts calendar.ts db.ts ./
COPY migrations ./migrations

EXPOSE 7400

# Use the tsx binary from node_modules directly, not `npx tsx` (which
# refetches tsx on every cold start when the local cache is missing).
CMD ["node", "--import", "tsx", "server.ts"]
