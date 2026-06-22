# @mcp-shim/connector

Customer-side connector per `MCP-TUNNEL.md` (held outside this repo).

The earlier PoC (in-shim LLM agent, `can_answer` / `ask_procedure`) is preserved on the `poc-testing` branch. Don't look there for productized-connector patterns.

## What it does

1. Reads `connector.yaml` (yaml-listed bundled / hand-written MCPs) AND auto-discovers customer-authored drop-in folders under `${MCP_DROPIN_DIR}/<name>/`:
   - **Type 1 (customer-authored, drop-in shape — default).** Folder under `mcp/local/<name>/{tools,prompts,resources}/*.ts`. No yaml entry, no `server.ts`. The drop-in scanner finds the folder; the synthesized child runtime ([`src/sdk/dropin-runner.ts`](src/sdk/dropin-runner.ts)) spawns a per-folder subprocess.
   - **Type 1 (hand-written, legacy escape hatch).** Yaml entry with `transport: http` + `dir:` (no `endpoint`). The connector spawns `tsx <dir>/server.ts` as a child. Used by `mcp/bundled/twilio/` (Twilio-authored Type 1 with the `twilio` SDK in its own `package.json`).
   - **Type 2 — connect to existing 3rd-party MCP.** Pushed via the controller UI (NOT the yaml) as `mcp-config-snapshot` / `mcp-config-delta` per [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) v1.1.
2. Connects to each, runs `tools/list` to discover their tools.
3. Builds a **`ToolManifest`** by aggregating every discovered tool. Trust boundary is per-MCP-server: pick which servers run, get every tool they expose.
4. Dials out to a controller URL via WSS and pushes `{ type: "register", manifest }`.
5. Dispatches inbound `tools/call name="${server}.${tool}"` requests to the right local MCP server.
6. Heartbeats; pushes `manifest-delta` on YAML reload (SIGHUP) or periodic discovery; sends `goodbye` on SIGTERM and SIGTERM each spawned Type 1 child.

The connector holds no LLM, runs no agent loop, and reads no documents. It is a tool dispatcher with policy.

## Wire protocol (frames)

Defined in [`src/tunnel/frames.ts`](src/tunnel/frames.ts); the contract for the controller team is **[`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md)**:

- `register { manifest }` — first frame after connect
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — graceful shutdown signal
- `webhook-allocate` / `webhook-allocate-ack` / `webhook` / `webhook-revoke` — webhook ingress, see [`.claude/plans/STATUS-CALLBACK-MCP.md`](../../.claude/plans/STATUS-CALLBACK-MCP.md)
- `creds-request` (out) / `creds-response` (in) / `creds-update` (in) — per-MCP creds protocol. The connector asks the controller for env values for each MCP after `register-ack`; the controller stores them in its existing UI/DB and pushes updates when an operator edits them. See [`.claude/plans/MCP-LOADING.md`](../../.claude/plans/MCP-LOADING.md).
- `mcp-config-snapshot` (in) / `mcp-config-delta` (in) / `mcp-config-ack` (out) / `mcp-config-resync` (out) — v1.1 controller-driven 3rd-party MCP roster. Operators manage 3rd-party MCPs through the controller UI; the controller pushes the roster to the connector over the existing tunnel. The connector reconciles in-memory (no yaml rewrite); auth shapes (`none` / `bearer` / `header` / `oauth2-client-credentials`) and HTTP-family transports (http / streamable-http / sse / websocket) are resolved at spawn time. WebSocket auth must be embedded in the URL — the SDK's WS transport accepts no headers. See [`.claude/plans/MCP-LOADING.md`](../../.claude/plans/MCP-LOADING.md) Workstream E and `docs/MCP-PROTOCOL.md` v1.1.

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`.

## Quick start (development)

The WS handshake is gated by per-tunnel auth that the controller mints. Before booting, create a row in the controller UI: **Tools → Connectors → Tunnel Security → New Tunnel Security**. Pick a Name (this becomes `CONNECTOR_NAME` — case-sensitive). Pick a security type and paste credentials:

- **Twilio Auth Token** or **Twilio API Key** → controller mints a long-lived `ts_<...>` bearer, shown once. Paste it into `TUNNEL_AUTH_TOKEN`.
- **OAuth 2.0 (client_credentials)** → controller mints a `client_id` + `client_secret`. Paste them into `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`, and set `OAUTH_TOKEN_URL` to the URL the UI shows. The connector mints a fresh 1h JWT against that endpoint on each reconnect (and refreshes <60s before expiry mid-session).

> The bundled Twilio MCP under [`mcp/bundled/twilio/`](../../mcp/bundled/twilio/) is AuthToken-only at the bundle-env layer. If you pick the **Twilio API Key** row type above for the tunnel handshake, the bundled MCP still needs `TWILIO_AUTH_TOKEN` — either via the controller's auto-fill (mint an Auth Token row alongside it) or pasted directly into `mcp/bundled/twilio/.env`.

```bash
# from repo root
npm install
npm run build

# Connector-level config — one yaml lists every MCP, one .env carries the tunnel bearer.
cp packages/connector/connector.yaml.example packages/connector/connector.yaml
cp packages/connector/.env.example packages/connector/.env
# edit .env:
#   CONTROLLER_URL=https://your-controller.example.com
#   CONNECTOR_NAME=<exact Name from the Tunnel Security row>
# then ONE of:
#   TUNNEL_AUTH_TOKEN=ts_<...>                     (Twilio Auth Token / API Key row)
# OR
#   OAUTH_CLIENT_ID=cid_tsec...                    (OAuth 2.0 row)
#   OAUTH_CLIENT_SECRET=cs_...
#   OAUTH_TOKEN_URL=https://your-controller.example.com/oauth2/token

./scripts/start-connector.sh
```

The WS upgrade sends `Authorization: Bearer <bearer>` plus `X-Connector-Name: <CONNECTOR_NAME>`. The controller looks up the `tunnel_security_configs` row by `(tenant_id, name)` and verifies the bearer (bcrypt-compare for `ts_<...>`, JWT signature + claims for OAuth2). Mismatch / missing header / unknown name → HTTP 401, no socket.

Once the WS is up, the connector also registers a `connectors` row using `tunnel.name` and persists the controller-issued `registrationToken` to `packages/connector/.connector-state.json`. Subsequent boots reconnect by token. Clear the state file to mint fresh — note that the Tunnel Security row is independent of the connectors row, so you don't need to recreate the bearer for that.

Rotate via the row's **Rotate Secret** (long-lived bearer) or by issuing a new client secret (OAuth2); previous credentials stay valid 24h so the connector can roll without coordinated downtime.

**Twilio takeover:** when Twilio takes over as the canonical OAuth issuer, an OAuth2 deployment flips `OAUTH_TOKEN_URL` to `https://oauth.twilio.com/v2/token`. No connector code change. The long-lived `ts_<...>` posture has no Twilio-takeover story — re-issue as OAuth2 if you want that property.

The connector serves an **inspector UI at http://localhost:9090/** showing:
- live WS state (connecting / open / closed)
- the current `ToolManifest` and an "Available Tools" list (every discovered tool is Ready)
- per-MCP **MCP Status** — process state, creds source (`controller (operator-entered)` / `controller (twilio-tunnel-row)` / `dir/.env` / `none`), restart count + last reason, tools count. Two per-MCP buttons: **Reload creds** (force a `creds-request` for that MCP and restart on response) and **Restart**.
- every frame in/out (register, register-ack, rpc, heartbeat, manifest-delta, webhook-*, creds-*)
- a **reconnect** button that re-reads YAML + redials (use after editing `policy`)

To pick up `mcp_servers` changes, restart the connector — those connections are made at process boot. `policy` changes pick up via Reconnect.

### Author a local MCP (drop-in)

Drop a folder under `mcp/local/<name>/tools/` with one or more tool files. That's it — no `server.ts`, no `package.json`, no `.env`, no yaml entry. The connector's drop-in scanner ([`src/dropin.ts`](src/dropin.ts)) discovers the folder at boot; the synthesized child runtime ([`src/sdk/dropin-runner.ts`](src/sdk/dropin-runner.ts)) wires every tool into a per-folder subprocess. Folder name = MCP name.

```ts
// mcp/local/my-mcp/tools/echo.ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const echo: Tool = {
  name: "echo",
  envKeys: ["ECHO_PREFIX"],   // optional — controller UI uses this hint to surface required keys
  register(server) {
    server.registerTool(
      "echo",
      {
        description: "Echo a string back.",
        inputSchema: { text: z.string() },
        outputSchema: { echoed: z.string().describe("The text we echoed back.") },
      },
      async ({ text }) => {
        const echoed = `${process.env.ECHO_PREFIX ?? ""}${text}`;
        return {
          structuredContent: { echoed },
          content: [{ type: "text", text: echoed }],
        };
      },
    );
  },
};
export default echo;
```

For more depth — env precedence, `Refresh local MCPs`, the third-party-SDK case — see [docs/AUTHOR-LOCAL-MCP.md](../../docs/AUTHOR-LOCAL-MCP.md).

`MCP_DROPIN_DIR` defaults to `/var/lib/mcp-connector/customer-mcps/` in production. In development, `scripts/start-connector.sh` exports it pointing at `mcp/local/`. Folders that *do* have a `server.ts` or *do* appear in `connector.yaml` are skipped — yaml entries and hand-written `server.ts` files stay authoritative (legacy escape hatch; new MCPs should use the drop-in shape).

#### Refresh without a restart

Picking up a freshly-dropped folder doesn't need a process restart. Two paths:

- **Controller UI** — Connector detail → MCPs tab → **Refresh local MCPs**. Emits a `local-mcps-rescan` frame down the WSS tunnel; the connector re-runs its drop-in scanner and reconciles new / removed folders against the running supervisor entries. Manifest changes ride the existing `manifest-delta` path. See [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"v1.2 — Local MCP rescan".
- **Inspector** — <http://localhost:9090/> → **MCP Status** panel → **Refresh local MCPs**. Loopback-only POST against the connector's inspector port; same coordinator method, no controller round-trip. Useful when iterating locally.

Operator-driven only — there's no fs-watcher. See DL4 in [.claude/plans/Done/MCP-LOADING-LOCAL.md](../../.claude/plans/Done/MCP-LOADING-LOCAL.md) for the rationale.

#### Per-MCP creds from the controller

If your tool needs env values (API keys, DB URLs, anything secret), declare them via `envKeys: string[]` on each `Tool` and let the controller push them down at runtime. After `register-ack`, the connector sends a `creds-request` per MCP with the de-duped union of every tool's `envKeys`; the controller stores the values in its existing UI / DB and replies with a `creds-response`. Operator edits trigger a `creds-update` push and the supervisor restarts the child with the new env. Today's `mcp/<type>/<name>/.env` files keep working as a fallback (controller-supplied env wins on conflict).

**Conditional tool registration** — when an MCP has hard creds requirements (e.g. `mcp/bundled/twilio/`), gate `tool` registration on env presence at the **server level**, NOT inside individual tools:

```ts
// mcp/bundled/<name>/server.ts (sketch)
const REQUIRED = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
const tools: Tool[] = [];
if (missing.length === 0) {
  const client = createClient();
  tools.push(toolA(client), toolB(client), /* ... */);
} else {
  log.warn({ missing, required: [...REQUIRED] }, "tools deferred — awaiting creds-update");
}
await createMcpHttpServer({ name: "<name>", tools, envKeys: REQUIRED });
```

Two things make this work:
- **`envKeys` declared at the server level** (not the per-tool `Tool.envKeys` field). The factory's `/envkeys` endpoint surfaces this list verbatim, so the connector's `creds-request` advertises the right keys even when zero tools have registered yet.
- **`tools: []` is a valid resting state.** The factory installs an explicit `tools/list` handler returning `{tools: []}` so the connector can build a manifest, register the MCP at the controller, and wait for `creds-update`. When creds arrive, the supervisor restarts the child; the new instance registers tools normally and a `manifest-delta` ships the tool list to the controller.

Keep individual tool files **unaware** of creds gating — register them or don't, but don't make each tool re-check `process.env`. That keeps tools clean and the gating concentrated in `server.ts`.

#### `outputSchema` + `structuredContent` — five rules

Every Type 1 / Type 3 tool advertises an `outputSchema` so controller-side procedure authors can write `{{ hydrate:<server>.<tool>.<field> }}` and have the field type-checked. The connector logs `error` per offending tool at boot if a Type 1 / Type 3 tool ships without one — the connector keeps booting (the tool just won't support hydration), but treat the log line as a release-blocker. (See [.claude/plans/OUTPUT-SCHEMA.md](../../.claude/plans/OUTPUT-SCHEMA.md).)

1. **Plain object of zod fields, NOT `z.object({...})`.** SDK convention — wrapping in `z.object` changes the inferred argument type and breaks the handler signature. See [`mcp/local/crm/tools/get-recent.ts`](../../mcp/local/crm/tools/get-recent.ts) for the canonical shape.
2. **Every field gets `.describe(...)`.** This is the contract authors read in the controller UI.
3. **Return both `content[]` AND `structuredContent` on success.** `content[0].text` is the human-readable form (LLM consumption); `structuredContent` is the machine-shaped sibling field that the controller's `projectPath()` reads from directly. Mismatch between the two is a bug — they should serialize to the same data.
4. **Schema describes the projection target, not the upstream SDK response.** For tools that wrap an external API, list *only* the fields the handler currently returns. Widen later if a procedure needs more.
5. **Errors return `content[]` only — no `structuredContent`.** Tool-level failure is signalled via `isError: true` (or just an error envelope in `content[0].text`). Do NOT also set `structuredContent` on the error path — the SDK validates `structuredContent` against `outputSchema` even when `isError: true`, and an error envelope shape (`{ error: "no_customer" }`) won't match a success schema. The schema describes the success shape only.

Type 2 tools (external `endpoint:` / `command:` MCPs) advertise whatever their upstream `tools/list` returns. The connector forwards that verbatim — schema or not — and the controller handles the missing-schema case gracefully.

#### Prompts and resources (v1.2)

Both follow the same author shape as tools — one module per item, exported with a `register(server)` that calls the SDK's `registerPrompt` / `registerResource`. **In drop-in folders** (the default authoring shape) the runner auto-discovers `prompts/*.ts` and `resources/*.ts` siblings of `tools/`; nothing else needed. Worked examples in [`mcp/local/sample/prompts/weather-briefing.ts`](../../mcp/local/sample/prompts/weather-briefing.ts) and [`mcp/local/sample/resources/uuids-recent.ts`](../../mcp/local/sample/resources/uuids-recent.ts).

```
mcp/local/my-mcp/
├── tools/
│   └── echo.ts            # exports default Tool { name, register }
├── prompts/
│   └── greeting.ts        # exports default Prompt { name, register }
└── resources/
    └── welcome.ts         # exports default Resource { name, register }
```

For the legacy hand-written shape, the factory accepts `prompts: Prompt[]` and `resources: Resource[]` alongside `tools`:

```ts
// mcp/local/my-mcp/server.ts (legacy escape hatch only)
await createMcpHttpServer({
  name: "my-mcp",
  tools: [echo],
  prompts: [greeting],          // optional; declares the `prompts` capability
  resources: [welcomeMessage],  // optional; declares the `resources` capability
});
```

The split mirrors what the protocol expects:

- **Tools** = side-effecting operations the procedure runtime invokes (`messages_create`, `issue_refund`, `voice_say`).
- **Prompts** = parameterised templates the controller's procedure-author UI consumes (`compose_compliant_sms_campaign`, `refund_eligibility_check`). Authored once per MCP, version-controlled.
- **Resources** = read-only canonical state surfaced as named, citeable artefacts (`twilio://content-templates`, `ek://sources/{source_id}`). Procedures read them via `resources/read` instead of burning a tool call. Authors that need server-pushed freshness signal `subscribe: true` on the underlying SDK call so the connector forwards `notifications/resources/updated` as `mcp-notification`.

The connector forwards the full server-method surface (`prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `completion/complete`, `logging/setLevel`) and wraps server-initiated notifications as the `mcp-notification` frame. See [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) §"v1.2 — MCP server-method extension" for the wire contract.

## Tests

Vitest skeleton for defensive regression tests. The suite is regression-driven: tests are added when manual scenarios surface real bugs. See [`.claude/plans/TEST-SUITE.md`](../../.claude/plans/TEST-SUITE.md).

```bash
cd packages/connector
npm test           # one-shot run
npm run test:watch # watch mode
```

Tests live at `packages/connector/tests/**/*.test.ts` mirroring `src/`. Use explicit `import { describe, it, expect } from "vitest"` — globals are off.

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
| `/app/mcp/bundled/` | Type 3 stubs (per-bundle `.env.example`); customer mounts a `.env` next to it for credentials |
| `/opt/bundled-mcps/<name>/.venv/` | Pre-installed Python venv per Type 3 bundle; the connector spawns `<entrypoint>` from `BUNDLED_MCPS` |

## Run standalone

```bash
# Inside a container the entrypoint is `node dist/index.js`. Mount your config:
docker run --rm \
  -v "$PWD/connector.yaml:/etc/mcp-connector/config.yaml:ro" \
  -e TUNNEL_AUTH_TOKEN=ts_... \
  -e CONNECTOR_NAME=my-customer \
  -e CONTROLLER_URL=https://controller.example.com \
  # CONNECTOR_NAME must match the Tunnel Security row's Name on the controller (case-sensitive).
  # tunnel.name comes from connector.yaml; first boot mints a connectors row, restart reconnects via state file
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

- mTLS / cert rotation
- OAuth 2.1 + RFC 8707 audience-bound MCP tokens
- QUIC transport (stays on WS)
- Live reconnect on `mcp_servers` YAML changes (requires process restart)

(Done: per-tunnel handshake auth bound to the customer's Twilio AccountSid via the controller's Tunnel Security UI; auto-reconnect with backoff.)

See `MCP-TUNNEL.md` (held outside this repo) for the full productization roadmap.
