# @mcp-shim/connector

Customer-side connector per `MCP-TUNNEL.md` (held outside this repo).

The earlier PoC (in-shim LLM agent, `can_answer` / `ask_procedure`) is preserved on the `poc-testing` branch. Don't look there for productized-connector patterns.

## What it does

1. Reads `connector.yaml` describing one or more **MCP servers**, each falling into one of two patterns:
   - **Type 1 — customer-authored.** `transport: http` + `dir:` (no `endpoint`). The connector spawns `tsx <dir>/server.ts` as a child, auto-assigns a localhost port, and treats it like any HTTP MCP from there.
   - **Type 2 — connect to existing.** `transport: http` with `endpoint:` set, or `transport: stdio` with `command:` set. Optional `dir:` whose `.env` is loaded into the child's environment.
2. Connects to each, runs `tools/list` to discover their tools.
3. Builds a **`ToolManifest`** by aggregating every discovered tool. Trust boundary is per-MCP-server: pick which servers run, get every tool they expose.
4. Dials out to a controller URL via WSS and pushes `{ type: "register", manifest }`.
5. Dispatches inbound `tools/call name="${server}.${tool}"` requests to the right local MCP server.
6. Heartbeats; pushes `manifest-delta` on YAML reload (SIGHUP) or periodic discovery; sends `goodbye` on SIGTERM and SIGTERM each spawned Type 1 child.

The connector holds no LLM, runs no agent loop, and reads no documents. It is a tool dispatcher with policy.

## Wire protocol (frames)

Defined in [`src/tunnel/frames.ts`](src/tunnel/frames.ts):

- `register { manifest }` — first frame after connect
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — graceful shutdown signal

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`.

## Quick start (development)

```bash
# from repo root
npm install
npm run build

# Connector-level config — one yaml lists every MCP, one .env carries shared tunnel secrets.
cp packages/connector/connector.yaml.example packages/connector/connector.yaml
cp packages/connector/.env.example packages/connector/.env
# edit .env: CONTROLLER_URL + TUNNEL_AUTH_TOKEN must match the controller's
# edit connector.yaml: pick a unique tunnel.name

./scripts/start-connector.sh
```

First boot the connector registers itself with the controller (mints a row keyed to `tunnel.name`, persists the controller-issued registrationToken to `packages/connector/.connector-state.json`). Subsequent boots reconnect by token. Clear the state file to mint fresh.

The connector serves an **inspector UI at http://localhost:9090/** showing:
- live WS state (connecting / open / closed)
- the current `ToolManifest` and an "Available Tools" list (every discovered tool is Ready)
- every frame in/out (register, register-ack, rpc, heartbeat, manifest-delta)
- a **reconnect** button that re-reads YAML + redials (use after editing `policy`)

To pick up `mcp_servers` changes, restart the connector — those connections are made at process boot. `policy` changes pick up via Reconnect.

### Author a Type 1 MCP

Drop a folder under `mcp/local/<name>/`:

```ts
// mcp/local/my-mcp/tools/echo.ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

export const echo: Tool = {
  name: "echo",
  register(server) {
    server.registerTool(
      "echo",
      { description: "Echo a string back.", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text }] })
    );
  },
};
```

```ts
// mcp/local/my-mcp/server.ts
import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { echo } from "./tools/echo.js";

await createMcpHttpServer({ name: "my-mcp", tools: [echo] });
```

```yaml
# packages/connector/connector.yaml
- name: my-mcp
  transport: http
  dir: ../../mcp/local/my-mcp
```

No `package.json`, no build step, no port to pick. The connector spawns `tsx server.ts` for you.

## CLI

The compiled `dist/index.js` is the entrypoint, with a shebang. Subcommands:

| Subcommand | Use |
|---|---|
| `start` (default) | run the connector. Spawns Type 1 children, dials Type 2 entries, opens the tunnel. Flags: `--config <path>`, `--inspector-port <n>`, `--no-inspector` |
| `init` | YAML wizard. Asks for tunnel fields, then walks you through Type 1 / Type 2 entries. `--output <path>`, `--force` |
| `discover` | non-interactive: print `tools/list` per server. `--config <path>` |
| `version` | print the connector version |

## Files that ship (in the OCI image)

| Path | Why |
|---|---|
| `dist/` | compiled JS (the entrypoint with shebang) |
| `public/` | inspector UI assets (HTML/JS/CSS) |
| `package.json` | metadata + the `bin` entry |
| `node_modules/` (production only) | `npm prune --omit=dev` in the build stage; includes `tsx` (used by the spawner) |
| `/app/mcp/local/` | Type 1 source folders; the spawner runs `tsx /app/mcp/local/<name>/server.ts` for entries with `dir:` set |
| `/app/mcp/external/` | Type 2 stubs (per-MCP `.env.example`); customer mounts a `.env` next to it for credentials |
| `/app/mcp/bundled/` | Type 3 stubs (per-bundle `.env.example`); customer mounts a `.env` next to it for credentials |
| `/opt/bundled-mcps/<name>/.venv/` | Pre-installed Python venv per Type 3 bundle; the connector spawns `<entrypoint>` from `BUNDLED_MCPS` |

## Run standalone

```bash
# Inside a container the entrypoint is `node dist/index.js`. Mount your config:
docker run --rm \
  -v "$PWD/connector.yaml:/etc/mcp-connector/config.yaml:ro" \
  -e TUNNEL_AUTH_TOKEN=... \
  -e CONTROLLER_URL=https://controller.example.com \
  # tunnel.name comes from connector.yaml; first boot mints, restart reconnects via state file
  -p 9090:9090 \
  mcp-connector:0.1.0 start

# Or directly:
CONNECTOR_CONFIG=./connector.yaml \
  node packages/connector/dist/index.js start
```

## Production deployment

See [docs/deploy/README.md](../../docs/deploy/README.md) plus the per-cloud guides:
[AWS Fargate](../../docs/deploy/aws-fargate.md),
[Azure Container Apps](../../docs/deploy/azure-container-apps.md),
[GCP GKE](../../docs/deploy/gcp-gke.md).

## Out of scope (production hardening)

- mTLS / cert rotation / Account-SID-bound tunnel auth
- OAuth 2.1 + RFC 8707 audience-bound MCP tokens
- QUIC transport (stays on WS)
- Auto-reconnect with backoff (manual reconnect button only)
- Live reconnect on `mcp_servers` YAML changes (requires process restart)

See `MCP-TUNNEL.md` (held outside this repo) for the full productization roadmap.
