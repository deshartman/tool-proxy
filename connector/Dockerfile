# Multi-stage build. Stages:
#   1. node-build      — workspace install + connector TS compile + per-MCP npm deps
#   2. runtime         — final image with connector dist + bundled-mcps/
#
# What ends up in the runtime image:
#   - the connector's compiled JS + its prod node_modules (incl. tsx)
#   - the inspector UI assets
#   - bundled-mcps/<name>/ trees so Twilio-authored MCPs can spawn / resolve
#     dir: paths at runtime.
#   - Type 2 (3rd-party) MCPs arrive via controller push per
#     docs/MCP-PROTOCOL.md v1.1; they have no on-disk presence.
#
# Customer drop-ins land at /var/lib/mcp-connector/customer-mcps/ via the
# derived-image or volume-mount delivery paths — never inside the image the
# connector ships from Twilio.

# ── Node build stage ───────────────────────────────────────────────────────
FROM node:22-alpine3.20@sha256:2289fb1fba0f4633b08ec47b94a89c7e20b829fc5679f9b7b298eaa2f1ed8b7e AS node-build
WORKDIR /repo

# Workspace install for the connector. MCP folders live outside the workspace
# graph (per CLAUDE.md) — their deps install in a separate step below so
# their node_modules don't bloat the connector layer.
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY connector/package.json connector/

RUN npm ci --workspaces --include-workspace-root

# Now the source.
COPY tsconfig.base.json ./
# @gtmi/toolproxy-protocol is a workspace sibling the connector depends on.
# npm links it into node_modules as a symlink to ../../protocol, so its source
# (for the build) and its dist (for the runtime, below) must both be present.
COPY protocol protocol
COPY connector connector

# Note: prior versions copied .env.example + connector.yaml.example here
# for the `mcp-connector init` scaffolder. Both templates were retired in
# the customer-repo carve-out (zero-config dev bootstrap replaces them),
# so the COPY line was removed. See scripts/start-connector.sh.

RUN npm run build

# Strip workspace dev deps for the runtime copy.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# Bundled MCPs (Twilio-authored). Type 1 (Node/TS) bundles live at
# bundled-mcps/<name>/. Per-entry Node deps install after the copy so deps
# don't leak across MCPs. Type 2 (3rd-party) MCPs come from the controller UI
# per docs/MCP-PROTOCOL.md v1.1 — no on-disk presence.
COPY bundled-mcps bundled-mcps

# Sample demo drop-in — reference MCP (now / slow_echo / uuid / weather +
# prompts + resources). Not part of bundled-mcps/ in the repo (examples/ is
# reference-only, not a runtime drop-zone per CLAUDE.md), but we WANT it in
# the image so operators have something visible in the inspector alongside
# agentic-memory. Landing under bundled-mcps/ so the scanner picks it up
# non-gated (approval-gated customer drop-ins would need controller UI
# confirmation to appear in the manifest).
COPY examples/demos/sample bundled-mcps/sample
COPY examples/demos/crm bundled-mcps/crm
COPY examples/demos/salesforce bundled-mcps/salesforce

RUN set -e; \
    for dir in bundled-mcps/*/; do \
      [ -f "$dir/package.json" ] || continue; \
      depcount=$(node -e \
        "console.log(Object.keys(require('./$dir/package.json').dependencies||{}).length)"); \
      if [ "$depcount" != "0" ]; then \
        echo "installing deps in $dir"; \
        (cd "$dir" && npm install --omit=dev --no-package-lock); \
      fi; \
    done

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-alpine3.20@sha256:2289fb1fba0f4633b08ec47b94a89c7e20b829fc5679f9b7b298eaa2f1ed8b7e AS runtime
WORKDIR /app

# su-exec is what the entrypoint uses to drop from root to mcp:mcp after
# chown'ing the master-key file.
RUN apk add --no-cache su-exec \
 && addgroup -S mcp \
 && adduser -S -G mcp -h /app mcp \
 && mkdir -p /etc/mcp-connector /var/lib/mcp-connector/customer-mcps \
 && chown -R mcp:mcp /app /etc/mcp-connector /var/lib/mcp-connector
# DO NOT set USER mcp — entrypoint needs root for chown, drops via su-exec
#
# NOTE on ownership (MCP-AUDIT #3): the chown above runs BEFORE the COPY lines
# below, and COPY defaults to 0:0 — so /app/node_modules, /app/connector/dist and
# /app/bundled-mcps ship ROOT-OWNED while the process runs as mcp. That is
# deliberate and must stay: an immutable code tree means a compromised child
# (which runs as the same uid as the connector) cannot rewrite the connector's
# own dist/ or a sibling MCP's tools to persist across a restart. Do NOT "fix"
# this by adding --chown=mcp:mcp to the COPY lines.
#
# The corollary is that nothing may write inside /app at runtime. The one thing
# that tried to — the agentic-memory mock's state file, which resolved relative
# to its own module — now writes under /var/lib/mcp-connector instead (see the
# AGENTIC_MEMORY_STATE_PATH ENV below). Anything else needing persistence
# belongs on that volume too, not next to the code.

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
# node_modules/@gtmi/toolproxy-protocol is a workspace symlink to ../../protocol.
# Without these two lines that link dangles in the image and the connector
# fails at its first import. dist + package.json only — no source, no tests.
COPY --from=node-build /repo/protocol/dist                ./protocol/dist
COPY --from=node-build /repo/protocol/package.json        ./protocol/package.json
COPY --from=node-build /repo/package.json                          ./package.json

# Bundled MCPs (Twilio-authored, Type 1 Node). The customer's runtime config
# resolves dir: paths against /app/bundled-mcps/<name>/ for spawning and
# per-entry .env merging. Type 2 (3rd-party) MCPs come from the controller UI
# per docs/MCP-PROTOCOL.md v1.1 — no on-disk presence. Customers extending the
# image with their own MCPs drop folders under
# /var/lib/mcp-connector/customer-mcps/ instead.
COPY --from=node-build /repo/bundled-mcps ./bundled-mcps

# Runtime entrypoint — decodes $CONNECTOR_KEY_B64 → $CONNECTOR_KEY_FILE on
# platforms whose secret store is env-only (Fly.io, ACA, etc.); no-op when
# the env is unset (docker-compose et al. that mount the file directly).
# See CODE-DEPLOY design record §"D2 — Master key delivery".
COPY connector/entrypoint.sh /usr/local/bin/mcp-connector-entrypoint.sh
RUN chmod +x /usr/local/bin/mcp-connector-entrypoint.sh

WORKDIR /app/connector

# Default config location — mount the customer's yaml at this path. dir:
# entries inside the yaml are resolved relative to the yaml's directory,
# so a yaml at /etc/mcp-connector/config.yaml referencing
# dir: /app/bundled-mcps/agentic-memory works.
ENV CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml
# Default master-key location — matches the path the entrypoint script
# writes to when $CONNECTOR_KEY_B64 is set (Fly.io / ACA / any secret-as-env
# platform). Override at deploy time if the operator mounts a key file
# somewhere else. Symmetric with CONNECTOR_CONFIG above; without this ENV
# the connector's env-loader fails with "CONNECTOR_KEY_FILE is required"
# even though the entrypoint just wrote the key to the default path.
ENV CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key
# Bundled MCPs dir. The runtime image copies bundled-mcps/ to /app/bundled-mcps
# at build time, and the connector's scanner (discoverBundled) reads this path
# to auto-register Twilio-shipped MCPs. Override at deploy time only when
# extending the image via volume mount rather than derived-image COPY.
ENV MCP_BUNDLED_DIR=/app/bundled-mcps
# agentic-memory's JSON state file (MCP-AUDIT #3 / #30). Without this it resolves
# relative to its own module — /app/bundled-mcps/agentic-memory/.state.json —
# which is root-owned per the ownership note above, so every mutating tool in the
# bundle failed EACCES in the image while working fine in dev where the developer
# owns the tree. /var/lib/mcp-connector IS created and chowned to mcp above, and
# is the volume mount point in every deploy target, so state survives a restart.
# state.ts creates the parent dir on first write and chmods the file to 0600.
ENV AGENTIC_MEMORY_STATE_PATH=/var/lib/mcp-connector/agentic-memory/.state.json

EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/mcp-connector-entrypoint.sh"]
CMD ["start"]
