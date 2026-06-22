# mcp-shim-connector

A customer-side **MCP connector**: dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests to the right local server.

The controller is **outside this repo**. This repo is the customer side only.

## Three ways to wire up an MCP

The connector understands three integration patterns. Type 1 and Type 3 are configured in `connector.yaml`; Type 2 is configured in the **controller UI** and pushed to the connector over the WSS tunnel.

- **Type 1 — customer-authored.** Drop tool files (`tools/*.ts`) plus a tiny `server.ts` into a folder under `mcp/local/`. The connector spawns it as a child via `tsx` and auto-assigns a localhost port. No build step, no port wrangling.
- **Type 2 — connect to an existing MCP (controller-pushed).** Operator clicks **New 3rd Party MCP** in the controller (Name, Transport, URL or command, Auth shape, optional extra envKeys). The controller persists + pushes the entry to this connector via `mcp-config-snapshot` / `mcp-config-delta` per [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) v1.1. No yaml edit, no folder under `mcp/`. Useful for off-the-shelf MCPs (e.g. Salesforce, Atlassian, public npm packages like `aviation-weather-mcp`).
- **Type 3 — bundled, Twilio-authored Python venv, pre-installed in this image.** The entry just sets `bundled: <name>`; the connector resolves it against a registry of bundles laid down at image-build time. Bundle source lives in-tree at `bundles/<name>/` (deliberately outside `mcp/` so the runtime image carries only the installed venv, not the build inputs). Customer supplies only a per-bundle `.env` under `mcp/bundled/<name>/`.

`mcp/bundled/` carries Twilio-shipped MCPs of *any* type — Type 1 Node MCPs (`mcp/bundled/twilio/`) and Type 3 Python venv MCPs (`mcp/bundled/enterprise-knowledge/`) cohabit. The folder marks "who ships it"; the YAML entry shape decides "how it's wired". The connector adds an `author: "twilio" | "customer"` field to each MCP on the wire, derived from the folder location, so the controller can group Twilio-shipped MCPs separately from customer-authored ones in its UI.

### Receiving webhooks

MCPs that need to receive inbound HTTPS POSTs (Twilio `statusCallback`, message-status updates, recording / fax / video status, anything that asks for a public URL) use the connector's webhook ingress instead of running a local listener or an ngrok tunnel. The public URL lives on the **controller** (`https://<controller-host>/api/webhook/<connectorId>/<token>`); the connector consumes events as `webhook` frames over the existing tunnel WS. The connector still opens **no inbound port**.

```ts
// inside any MCP's server.ts (Type 1 or Type 3 alike)
import { createWebhookEndpoint } from "@mcp-shim/connector/sdk";

// `mcp` must match this MCP's name in connector.yaml — i.e. the name the
// connector announces in the manifest. For the bundled twilio MCP that's
// "apis" (see mcp/bundled/twilio/server.ts).
const cb = await createWebhookEndpoint({ mcp: "<your-mcp-name>" });
cb.on("callback", ({ body, queryParameters, headers }) => {
  // body is already JSON-parsed by the controller — DO NOT call JSON.parse on it.
  // headers is allowlisted to X-Twilio-* + Content-Type.
});

// pass cb.url into any Twilio API that accepts a callback
await twilio.messages.create({ to, body, statusCallback: cb.url });
```

URL contract:
- Stable **prefix** (rowId follows `connectorId`); pasted Twilio configs keep resolving across connector restarts.
- Random **tail** re-mints on every reconnect — listen for `cb.on("url", …)` if you cache the URL anywhere (most authors don't need to).
- Bcrypt-protected on the controller; the connector never persists it.

When the WS is down the controller returns 503 and Twilio retries upstream — the connector does **not** buffer.

## Layout

```
packages/
  connector/                  the customer-side process (only thing that ships)
    connector.yaml.example    single yaml listing every MCP — Type 1, 2, and 3
    .env.example              tunnel env (CONTROLLER_URL, CONNECTOR_NAME, plus EITHER TUNNEL_AUTH_TOKEN OR OAUTH_CLIENT_ID/SECRET/TOKEN_URL — minted by the controller)
mcp/
  local/
    sample/                   Type 1 — now, slow_echo, uuid, weather
    crm/                      Type 1 — get_customer / get_recent / issue_refund (thin client over mock/customers/)
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

Before booting the connector you need a **Tunnel Security row** on the controller — that's where the connector's handshake credential comes from. In the controller UI go to **Tools → Connectors → Tunnel Security → New Tunnel Security**, enter:

- **Name** — pick a unique connector name (case-sensitive). This must match `CONNECTOR_NAME` in your `.env` exactly.
- **Security type** — pick one:
  - **Twilio Auth Token** or **Twilio API Key** → controller mints a long-lived `ts_<...>` bearer (paste into `TUNNEL_AUTH_TOKEN`).
  - **OAuth 2.0 (client_credentials)** → controller mints a `client_id` + `client_secret`. The connector POSTs them to `OAUTH_TOKEN_URL` to get a fresh 1h JWT on each connect. Best when you want a config-flip migration to `oauth.twilio.com` once Twilio takes over as the issuer.
- **Twilio credentials** — Account SID + Auth Token, or Account SID + API Key SID + API Key Secret. The controller verifies against Twilio's API at save time.

Click Save. The controller shows the minted credentials once — copy.

> **Note for the bundled Twilio MCP:** the bundle is AuthToken-only — its child env reads `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (see [`mcp/bundled/twilio/.env.example`](mcp/bundled/twilio/.env.example)). Picking the API Key row type above is fine for the tunnel handshake itself, but if you want the bundled MCP to work you also need an Auth Token — either as a sibling row used by the connector, or pasted into `mcp/bundled/twilio/.env` directly. See [`docs/MCP-PROTOCOL.md`](docs/MCP-PROTOCOL.md) "Twilio-bundled auto-fill" for the full table.

```bash
npm install
npm run build

# Connector-level config: one yaml, one .env.
cp packages/connector/connector.yaml.example packages/connector/connector.yaml
cp packages/connector/.env.example packages/connector/.env
# edit packages/connector/.env. Always:
#   CONTROLLER_URL=https://your-controller.example.com
#   CONNECTOR_NAME=<exact Name from the Tunnel Security row>
# then EITHER (Twilio Auth Token / API Key row):
#   TUNNEL_AUTH_TOKEN=ts_<...>
# OR (OAuth 2.0 row):
#   OAUTH_CLIENT_ID=cid_tsec...
#   OAUTH_CLIENT_SECRET=cs_...
#   OAUTH_TOKEN_URL=https://your-controller.example.com/oauth2/token

./scripts/start-connector.sh
```

That's it — the connector spawns each Type 1 child via `tsx` (no build), dials each Type 2 entry, and surfaces them all in the inspector at <http://localhost:9090/>. The WS upgrade carries `Authorization: Bearer <bearer>` plus `X-Connector-Name: <CONNECTOR_NAME>`; the controller looks up the row by name and verifies the bearer (bcrypt-compare for `ts_<...>`, JWT signature + claims for OAuth2). On the **first** run, after the WS is up, the connector also registers a `connectors` row using `tunnel.name` and persists the controller-issued `registrationToken` to `packages/connector/.connector-state.json`. Subsequent restarts reconnect by both the handshake credential and the registration token.

Rotate the bearer via **Rotate Secret** on the row's detail page; the previous secret stays valid for 24h so connectors can roll without coordinated downtime.

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

**Type 2** (3rd-party MCPs come from the controller, not yaml):

Add the MCP in the controller UI: **New 3rd Party MCP** → enter Name, Transport (http / streamable-http / sse / websocket / stdio), URL or Command, Auth shape (None / Bearer / Custom Header / OAuth2 client_credentials), and any extra `envKeys`. The controller pushes the entry to this connector over the WSS tunnel via `mcp-config-snapshot` / `mcp-config-delta`. The connector reconciles in-memory and connects through the existing supervisor path. Per-MCP creds flow through the same `creds-request` / `creds-response` / `creds-update` frames as bundled MCPs do today.

See [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) §"v1.1 — 3rd-party MCP roster (controller-driven)" for the wire format.

**Type 3** (use a bundled, Twilio-authored Python venv MCP):

```yaml
- name: enterprise_knowledge
  bundled: enterprise-knowledge
  dir: ../../mcp/bundled/enterprise-knowledge   # for the .env
```

The bundle's source lives in-tree at [`bundles/enterprise-knowledge/`](bundles/enterprise-knowledge/). The connector image installs it into `/opt/bundled-mcps/enterprise-knowledge/`; in dev, `start-connector.sh` auto-points at the bundle's `dev-launch.sh` in the working tree.

Twilio-authored Node MCPs follow the Type 1 shape but live under `mcp/bundled/<name>/` (e.g. [`mcp/bundled/twilio/`](mcp/bundled/twilio/)) so they're tagged `author: "twilio"` on the wire. Same `transport: http` + `dir:` yaml shape as customer-authored Type 1; only the path differs.

## Inspector

`http://localhost:9090/` (binds to 127.0.0.1 only — see **What's load-bearing** below) shows live WS state, the `ToolManifest`, MCP Status, Webhooks, and the frame log. Two click-targets on every MCP server card: the grey "MCP SERVER" header expands/collapses the tool list; the purple `<name>` opens an **MCP creds view** in the right pane where developers can paste session creds for local smoke-testing (12h hard TTL, never persisted, never sent to the controller).

Full reference: [`docs/INSPECTOR.md`](docs/INSPECTOR.md).

To pick up changes to `mcp_servers`, restart the script — those connections happen at boot. `policy` changes pick up via the **Reconnect** button.

## Tests

```bash
cd packages/connector
npm test            # one-shot vitest run
npm run test:watch  # watch mode
```

Tests live at `packages/connector/tests/**/*.test.ts` (peer-tests, not colocated — keeps tests outside `tsconfig.json`'s `rootDir: "src"` so they don't compile into `dist/` and ship in the OCI image). Suite is regression-driven: cases are added when manual scenarios surface real bugs, not for coverage.

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

- **Outbound only.** The connector opens no inbound public ports for the tunnel — and that includes webhook ingress (the public URL lives on the controller; see "Receiving webhooks" above).
- **Trust boundary is per MCP server, not per tool.** Every tool a configured MCP server exposes is forwarded — pick which servers run carefully.
- **Inspector binds to 127.0.0.1 only.** It carries the bcrypt-protected webhook URL with a copy button by design. Reach it via port-forward / exec, never via a public LB.
- **No LLM, no agent loop, no document handling.** This is a tool dispatcher with policy.

See [CLAUDE.md](CLAUDE.md) and [packages/connector/README.md](packages/connector/README.md) for details.

## Reference branch

The earlier proof-of-concept (in-shim LLM agent, document adapters, `can_answer` / `ask_procedure` tool surface) is preserved on the `poc-testing` branch.
