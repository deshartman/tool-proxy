# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests. Per the productized design in `MCP-TUNNEL.md` (held outside this repo).

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

## Demo topology — many pairings, one binary

The repo ships **one connector binary** (`packages/connector`) and **demo MCP servers** under `examples/`. The dev loop runs one connector process per MCP server, all dialing the same controller, each with a distinct `connector_id`. This emulates "many customers / many parties" on a single machine; in production each `connector_id` runs in its own container.

```
examples/sample-mcp-server :7100  ←─ connector → controller_url   (inspector :9090, id=conn_…)
examples/twilio-mcp-server :7200  ←─ connector → controller_url   (inspector :9091, id=conn_…)
```

Sample tools: `now`, `slow_echo`, `uuid`, `weather`. Twilio tools: `send_sms`, `lookup_phone_number`, `list_recent`.

Each MCP server directory owns its full pairing: `connector.yaml`, `connector.yaml.example`, `.env`, `.env.example`. The `.env` carries the per-pairing `CONNECTOR_ID` / `TUNNEL_AUTH_TOKEN` / `INSPECTOR_PORT` / MCP server `PORT`. The repo-root `.env` carries only what's genuinely shared (`CONTROLLER_URL`, `CONNECTOR_VERSION`).

Adding a new demo MCP server: drop a folder under `examples/`, give it `connector.yaml{,.example}` + `.env{,.example}` + a normal MCP server `dist/index.js`, then append the directory to `MCP_DIRS` in `scripts/run-connector.sh`.

The controller is **outside this repo** — this repo only ships the customer side.

## Architecturally load-bearing properties

- **Outbound-only.** The connector opens **no inbound ports** for the tunnel. It dials out; the controller pushes RPC requests back down the same WS the connector opened.
- **Trust boundary is per MCP server, not per tool.** Every tool a server in `mcp_servers[]` exposes is forwarded to the controller. The customer controls *which* MCP servers run on their machine; that's the gate. We deliberately diverged from MCP-TUNNEL.md §"Configuration surface" (which prescribes a default-deny `allow_list.tools` block) — per-tool gating duplicated authority and forced a YAML edit on every new tool. Don't reintroduce `allow_list` without an explicit ask. The wire format keeps `ToolDescriptor.allowed` (controller may still display it; future enterprise-strict mode might use it) — the connector always sets it to `true`.
- **Pre-provisioned `connector_id`.** YAML carries the ID; the controller's persistence layer must know it. An unknown ID is silently dropped by some controllers (it looks like a no-op, not an error).
- **No LLM, no agent loop, no document handling.** If you find yourself adding `openai` or anything that reads documents, stop — that belongs on the controller side or in a separate process, not here.

## Wire protocol — frames

Defined in [packages/connector/src/tunnel/frames.ts](packages/connector/src/tunnel/frames.ts):

- `register { manifest }` — first frame after WS open
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — sent on SIGTERM before WS close

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`. Some controllers also send a `register-ack` frame back; the connector parses and ignores it (non-spec, but harmless).

## Workspaces

npm workspaces, **one package**: `@mcp-shim/connector`. That's the only thing that ships.

Demo MCP servers under `examples/` are deliberately **not** workspaces — each is a standalone npm package with its own `node_modules`. This keeps demo dependencies (e.g. the Twilio SDK) out of the connector image and out of the workspace install graph. First-time setup runs `npm install && npm run build` inside each `examples/*/` directory you want to use.

- **`packages/connector`** — the customer-side process. YAML config, MCP clients to local servers, WSS tunnel, dispatcher, inspector UI, CLI (`start` / `init` / `discover` / `version`). The only thing in the OCI image.
- **`examples/sample-mcp-server`** — stub MCP server. Tools one-per-file under `src/tools/` (`now`, `slow_echo` for timeout testing, `uuid`, `weather` against weather.gov). Demo + verification target.
- **`examples/twilio-mcp-server`** — standalone example wrapping Twilio's APIs as MCP tools (`send_sms`, `lookup_phone_number`, `list_recent`). Demonstrates the connector treats Twilio's APIs identically to any other customer-side MCP. Its `twilio` SDK never enters the connector image.

The sample server uses a stateful `StreamableHTTPServerTransport` with `randomUUID` session IDs. **Stateless mode does not work** with the SDK's HTTP transport — it requires a per-request transport instance. We bounce the MCP servers in `run-connector.sh` on every script restart so a stuck session from a prior run doesn't 500.

## CLI subcommands

[packages/connector/src/index.ts](packages/connector/src/index.ts) dispatches on `argv[0]`:

| Subcommand | Module | Notes |
|---|---|---|
| `start` (default) | `index.ts` `main()` | dials the tunnel; flags: `--config`, `--inspector-port`, `--no-inspector` |
| `init` | [packages/connector/src/init.ts](packages/connector/src/init.ts) | discovery-driven YAML wizard; uses `node:readline` (no new deps); refuses overwrite without `--force` |
| `discover` | [packages/connector/src/discover.ts](packages/connector/src/discover.ts) | non-interactive `tools/list` per server, then exits |
| `version` | inline | prints `CONNECTOR_VERSION` or `dev` |

A startup boot log in `main()` prints `auth_token=set (len=N) | absent` so a silently-unauthenticated connector is impossible to miss. Don't remove it.

## Common commands

```bash
# Connector (workspace).
npm install
npm run build

# Demo MCP servers (standalone — install + build each one you want to use).
(cd examples/sample-mcp-server && npm install && npm run build)
(cd examples/twilio-mcp-server && npm install && npm run build)

# Repo-root .env carries CONTROLLER_URL only.
cp .env.example .env

# Per-pairing env + YAML. Each examples/<server>/ has its own.
cp examples/sample-mcp-server/.env.example examples/sample-mcp-server/.env
cp examples/sample-mcp-server/connector.yaml.example examples/sample-mcp-server/connector.yaml
cp examples/twilio-mcp-server/.env.example examples/twilio-mcp-server/.env
cp examples/twilio-mcp-server/connector.yaml.example examples/twilio-mcp-server/connector.yaml

./scripts/run-connector.sh
```

Inspector UIs: <http://localhost:9090/> (sample), <http://localhost:9091/> (twilio).

`run-connector.sh` auto-skips a pairing whose `.env` lists `TWILIO_ACCOUNT_SID=` empty, so the script still boots if you don't have Twilio creds set.

There are **no tests**. Verification is interactive via the inspector UI:
- "MCP Server" panel shows the local MCP servers and their tools.
- "Available Tools" panel lists each discovered tool with a "Ready" verdict.
- "Frames" panel shows live WS state + every frame in/out (filterable; heartbeats hidden by default).
- "Reconnect" button **re-reads the YAML** (`policy` changes), then redials. To pick up changes to `mcp_servers`, restart the script — those connections happen at boot.

## Inspector UI notes

The inspector lives inside the connector process at `INSPECTOR_PORT` (default 9090). It is part of the customer side; it does **not** proxy or impersonate the controller. It only renders what *this* connector is doing.

Token-based renderer for tool shape cards in [packages/connector/public/app.js](packages/connector/public/app.js): each token is `[cssClass, text]` and gets HTML-escaped at render time. Don't reintroduce regex-based replacement for syntax highlighting — it dragged in control-character ambiguity that the linter rightly complained about.

The left column is draggable; the width is persisted in `localStorage` under `inspector.leftColPx`.

## Config files

| File | Purpose |
|------|---------|
| `.env` (repo root)                                          | live, shared env: `CONTROLLER_URL`, optional `CONNECTOR_VERSION`. Gitignored. |
| `.env.example` (repo root)                                  | template, committed. |
| `examples/<server>/.env`                                    | per-pairing live env: `CONNECTOR_ID`, `TUNNEL_AUTH_TOKEN`, `INSPECTOR_PORT`, MCP server `PORT`, plus any third-party API creds (e.g. `TWILIO_*`). Gitignored. |
| `examples/<server>/.env.example`                            | per-pairing template, committed. |
| `examples/<server>/connector.yaml`                          | live YAML for this pairing. References `${CONTROLLER_URL}`, `${CONNECTOR_ID}`, `${TUNNEL_AUTH_TOKEN}`. Gitignored. |
| `examples/<server>/connector.yaml.example`                  | template, committed. |

The YAML supports `${VAR}` and `${VAR:-default}` interpolation; unknown vars without a default throw with the variable name and YAML line so the customer can fix the right line. `run-connector.sh` sources both the repo-root `.env` (shared) and the pairing's `.env` (per-process), then invokes the connector with `CONNECTOR_CONFIG=<absolute path to that pairing's connector.yaml>`. In Docker, set the same vars via container env — there is no `.env` inside the image.

In production, each `connector_id` is its own container — there's no concept of "multiple pairings on one machine." The repo-root + per-pairing split is purely for the dev loop.

## Reconnect semantics

- WS close does **not** kill the connector process. It transitions the inspector to `closed` state and stops timers; the user can hit the reconnect button to redial.
- Reconnect re-reads the YAML. If `mcp_servers` changed, the connector logs a warning and uses the prior list (live MCP server reconnect is out of scope). `policy` changes take effect.
- Controller-side restarts (e.g. ngrok tunnel cycling) are handled by clicking reconnect.

## Process lifecycle gotcha

`scripts/run-connector.sh` spawns one MCP server + one connector per directory in `MCP_DIRS`, all as children. The script's pre-cleanup uses `pgrep -f 'scripts/run-connector\.sh'` and skips its own PID — do NOT replace this with `pkill -f` patterns that match `node dist/index.js`, because that catches unrelated node processes and does not catch orphan wrapper shells.

## Distribution

Primary shape is a signed multi-arch OCI image. Build:

```bash
./scripts/build-image.sh                                # local single-arch
IMAGE=registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh  # multi-arch + push
```

[packages/connector/Dockerfile](packages/connector/Dockerfile) is multi-stage; runtime image only carries the connector's `dist/` + `public/` + production `node_modules`. **`sample-mcp-server` is not in the image** — the connector only imports from its own package, and shipping the sample's stuff would mislead customers about what runs in their cluster.

[scripts/build-image.sh](scripts/build-image.sh) defaults to `linux/amd64,linux/arm64` (Graviton + ARM Macs). Per-cloud guides at [docs/deploy/](docs/deploy/) (AWS Fargate, Azure Container Apps, GCP GKE) document the foot-guns of each platform — most importantly, **don't put a load balancer in front of the connector** (nothing inbound) and **don't use Cloud Run / App Service / scale-to-zero anything** (kills the WSS).

## OpenAI / LLM

There is no LLM client in this repo. If a future change brings one in, that's a strong signal something's drifting away from the productized design.

Historical note (preserved for any future LLM integration in *adjacent* code): `gpt-5.x` chat completions require `max_completion_tokens` (not `max_tokens`) and reject any `temperature` other than the default.

## Reference branch

The original PoC (in-shim LLM agent, document adapters, `can_answer`/`ask_procedure` tools) is preserved on the `poc-testing` branch. Do not look there for productized-connector patterns — it answers a different question.
