# @mcp-shim/connector

Customer-side connector per [docs/MCP-TUNNEL.md](../../../Conversations/memory-deepdive/docs/MCP-TUNNEL.md).

This is a **new build** — the existing PoC under `packages/shim`, `packages/main-server`, `packages/client`, and `packages/local-server` is reference material from an earlier design. It uses a different wire protocol and tool surface and does not interoperate with this connector.

## What it does

1. Reads a YAML config describing one or more **local MCP servers** (HTTP or stdio).
2. Connects to each, runs `tools/list` to discover their tools.
3. Builds a **`ToolManifest`** by aggregating discovered tools, applying the customer's `allow_list` (default-deny).
4. Dials out to a controller URL via WSS and pushes `{ type: "register", manifest }`.
5. Dispatches inbound `tools/call name="${server}.${tool}"` requests to the right local MCP server.
6. Heartbeats; pushes `manifest-delta` on YAML reload (SIGHUP) or periodic discovery; sends `goodbye` on SIGTERM.

The connector holds no LLM, runs no agent loop, and reads no documents. It is a tool dispatcher with policy.

## Wire protocol (frames)

Defined in [`src/tunnel/frames.ts`](src/tunnel/frames.ts):

- `register { manifest }` — first frame after connect
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — graceful shutdown signal

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`.

## Quick start

```bash
# from repo root
npm install
npm run build

# Copy the templates (the .yaml is gitignored so it stays your local config).
cp packages/connector/config/connector-a.yaml.example packages/connector/config/connector-a.yaml
cp packages/connector/config/connector-a.env.example  packages/connector/config/connector-a.env

# Edit packages/connector/config/connector-a.yaml:
#   - tunnel.controller_url   public WSS URL of your controller (e.g. ngrok)
#   - tunnel.connector_id     pre-provisioned ID from the controller side
#   - allow_list.tools        which tools you want to expose

./scripts/run-connector.sh
```

The connector serves an **inspector UI at http://localhost:9090/** showing:
- live WS state (connecting / open / closed)
- the current `ToolManifest` and per-tool allow/deny verdicts
- every frame in/out (register, register-ack, rpc, heartbeat, manifest-delta)
- a **reconnect** button that re-reads YAML + redials (use after editing
  `allow_list` or `policy`)

To pick up `mcp_servers` changes, restart the connector — those connections
are made at process boot.

## Out of scope (production hardening)

- mTLS / cert rotation / Account-SID-bound tunnel auth
- OAuth 2.1 + RFC 8707 audience-bound MCP tokens
- QUIC transport (stays on WS)
- Auto-reconnect with backoff (manual reconnect button only)
- Live reconnect on `mcp_servers` YAML changes (requires process restart)

See [docs/MCP-TUNNEL.md](../../../Conversations/memory-deepdive/docs/MCP-TUNNEL.md) for the full productization roadmap.
