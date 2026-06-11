# mcp-shim-connector

A customer-side **MCP connector**: dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests to the right local server.

The controller is **outside this repo**. This repo is the customer side only.

## Three ways to wire up an MCP

The connector understands three integration patterns. All three go in the same `mcp_servers:` list in `connector.yaml`.

- **Type 1 — customer-authored.** Drop tool files (`tools/*.ts`) plus a tiny `server.ts` into a folder under `mcp/local/`. The connector spawns it as a child via `tsx` and auto-assigns a localhost port. No build step, no port wrangling.
- **Type 2 — connect to an existing MCP.** Pure config — the entry just declares `transport: http` + `endpoint`, or `transport: stdio` + `command`, and optionally a `dir` (under `mcp/external/`) whose `.env` is loaded into the child's environment. Useful for off-the-shelf servers (e.g. Salesforce, Atlassian, the bundled `aviation-weather-mcp`).
- **Type 3 — bundled, Twilio-authored Python venv, pre-installed in this image.** The entry just sets `bundled: <name>`; the connector resolves it against a registry of bundles laid down at image-build time. Bundle source lives in-tree at `bundles/<name>/` (deliberately outside `mcp/` so the runtime image carries only the installed venv, not the build inputs). Customer supplies only a per-bundle `.env` under `mcp/bundled/<name>/`.

`mcp/bundled/` carries Twilio-shipped MCPs of *any* type — Type 1 Node MCPs (`mcp/bundled/twilio/`) and Type 3 Python venv MCPs (`mcp/bundled/enterprise-knowledge/`) cohabit. The folder marks "who ships it"; the YAML entry shape decides "how it's wired". The connector adds an `author: "twilio" | "customer"` field to each MCP on the wire, derived from the folder location, so the controller can group Twilio-shipped MCPs separately from customer-authored ones in its UI.

## Layout

```
packages/
  connector/                  the customer-side process (only thing that ships)
    connector.yaml.example    single yaml listing every MCP — Type 1, 2, and 3
    .env.example              shared tunnel env (CONTROLLER_URL, TUNNEL_AUTH_TOKEN)
mcp/
  local/
    sample/                   Type 1 — now, slow_echo, uuid, weather
    crm/                      Type 1 — get_customer / get_recent / issue_refund (thin client over mock/customers/)
  external/
    aviation-weather/         Type 2 — pure config; spawns published `aviation-weather-mcp` via stdio
  bundled/
    twilio/                   Type 1 (Node) — Twilio-authored; ships its own twilio SDK locally
    enterprise-knowledge/     Type 3 (Python venv) — .env stub only (source lives at bundles/enterprise-knowledge/)
bundles/
  enterprise-knowledge/       Type 3 source — pip-installed into the image's bundled-mcps venv
docs/deploy/                  per-cloud deployment guides
scripts/
  start-connector.sh          boots the connector. Auto-registers with the controller on first run
                              (writes registrationToken to .connector-state.json), reconnects by token after.
  build-image.sh              builds the multi-arch OCI image
```

`packages/connector/connector.yaml` is the **single** source of truth: one entry per MCP. There is no per-folder `connector.yaml` any more. Per-folder `.env` files under `mcp/<type>/<name>/` carry only that MCP's own credentials and are loaded into that child's process — they don't leak across MCPs.

## Quick start (development)

```bash
npm install
npm run build

# Connector-level config: one yaml, one .env.
cp packages/connector/connector.yaml.example packages/connector/connector.yaml
cp packages/connector/.env.example packages/connector/.env
# edit packages/connector/.env: CONTROLLER_URL, TUNNEL_AUTH_TOKEN
# edit packages/connector/connector.yaml: pick a unique tunnel.name

./scripts/start-connector.sh
```

That's it — the connector spawns each Type 1 child via `tsx` (no build), dials each Type 2 entry, and surfaces them all in the inspector at <http://localhost:9090/>. On the **first** run it registers itself with the controller using `tunnel.name` and persists the controller-issued registrationToken to `packages/connector/.connector-state.json`. Subsequent restarts reconnect via that token.

## Adding a new MCP

**Type 1** (you write the tools):

```bash
mkdir -p mcp/local/my-mcp/tools
# write mcp/local/my-mcp/tools/<tool>.ts files (Tool interface from @mcp-shim/connector/sdk)
# write mcp/local/my-mcp/server.ts: createMcpHttpServer({name, tools})
# add an entry to packages/connector/connector.yaml:
#   - name: my-mcp
#     transport: http
#     dir: ../../mcp/local/my-mcp
```

Every Type 1 folder carries its own `package.json` (lists name + identity). When you only need `zod` and the SDK, leave `dependencies` empty — both resolve from the repo's root `node_modules` via the workspace hoist. When you need a third-party SDK (e.g. Salesforce, HubSpot, `axios`), add it to the folder's `dependencies` block and `start-connector.sh` will install it on first boot. [`mcp/bundled/twilio/`](mcp/bundled/twilio/) is the live example: a Twilio-authored Type 1 carrying the `twilio` SDK in its own `node_modules`, never hoisted to the workspace.

**Type 2** (you point at an existing MCP):

```yaml
- name: salesforce
  transport: http
  endpoint: https://salesforce-mcp.example.com/mcp
  dir: ../../mcp/external/salesforce     # optional, for the .env

- name: filesystem
  transport: stdio
  command: [npx, "--yes", "@modelcontextprotocol/server-filesystem", /tmp]
```

**Type 3** (use a bundled, Twilio-authored Python venv MCP):

```yaml
- name: enterprise_knowledge
  bundled: enterprise-knowledge
  dir: ../../mcp/bundled/enterprise-knowledge   # for the .env
```

The bundle's source lives in-tree at [`bundles/enterprise-knowledge/`](bundles/enterprise-knowledge/). The connector image installs it into `/opt/bundled-mcps/enterprise-knowledge/`; in dev, `start-connector.sh` auto-points at the bundle's `dev-launch.sh` in the working tree.

Twilio-authored Node MCPs follow the Type 1 shape but live under `mcp/bundled/<name>/` (e.g. [`mcp/bundled/twilio/`](mcp/bundled/twilio/)) so they're tagged `author: "twilio"` on the wire. Same `transport: http` + `dir:` yaml shape as customer-authored Type 1; only the path differs.

## Inspector

`http://localhost:9090/` shows:

- live WS state (connecting / open / closed)
- the `ToolManifest` and an "Available Tools" list (all discovered tools are Ready)
- every frame in/out
- a **Reconnect** button that re-reads the YAML and redials

To pick up changes to `mcp_servers`, restart the script — those connections happen at boot. `policy` changes pick up via Reconnect.

## CLI

```
mcp-connector start         run the connector (default; auto-registers on first connect)
mcp-connector init          interactive wizard to write connector.yaml
mcp-connector discover      print tools/list per configured server, then exit
mcp-connector version       print the connector version
```

## Production deployment

See [docs/deploy/README.md](docs/deploy/README.md) and the per-cloud guides:
[AWS Fargate](docs/deploy/aws-fargate.md), [Azure Container Apps](docs/deploy/azure-container-apps.md),
[GCP GKE](docs/deploy/gcp-gke.md).

## What's load-bearing

- **Outbound only.** The connector opens no inbound ports for the tunnel.
- **Trust boundary is per MCP server, not per tool.** Every tool a configured MCP server exposes is forwarded — pick which servers run carefully.
- **No LLM, no agent loop, no document handling.** This is a tool dispatcher with policy.

See [CLAUDE.md](CLAUDE.md) and [packages/connector/README.md](packages/connector/README.md) for details.

## Reference branch

The earlier proof-of-concept (in-shim LLM agent, document adapters, `can_answer` / `ask_procedure` tool surface) is preserved on the `poc-testing` branch.
