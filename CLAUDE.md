# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests. Per the productized design in `MCP-TUNNEL.md` (held outside this repo).

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

## Two runtime processes (demo)

```
sample-mcp-server (process)             connector (process)
  └─ HTTP MCP server :7100                ├─ WSS tunnel client → controller_url
     ├─ tool: echo                        ├─ MCP clients → local MCP servers
     ├─ tool: now                         └─ inspector UI :9090
     └─ tool: slow_echo
```

The connector dials a public controller URL (e.g. an ngrok WSS endpoint that fronts the real controller). The controller is **outside this repo** — this repo only ships the customer side.

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

npm workspaces, two packages:

- **`@mcp-shim/connector`** — the customer-side process. YAML config, MCP clients to local servers, WSS tunnel, dispatcher, inspector UI.
- **`@mcp-shim/sample-mcp-server`** — a tiny stub MCP server (HTTP transport) exposing `echo`, `now`, `slow_echo` (the last one tests `tool_timeout_ms`). Verification target only.

The sample server uses a stateful `StreamableHTTPServerTransport` with `randomUUID` session IDs. **Stateless mode does not work** with the SDK's HTTP transport — it requires a per-request transport instance. We bounce the sample server in `run-connector.sh` on every script restart so a stuck session from a prior run doesn't 500.

## Common commands

```bash
npm install
npm run build

# First-time setup: create a real config from the template, edit controller_url + connector_id.
cp packages/connector/config/connector-a.yaml.example packages/connector/config/connector-a.yaml
cp packages/connector/config/connector-a.env.example  packages/connector/config/connector-a.env

./scripts/run-connector.sh
```

Then open the inspector UI: <http://localhost:9090/>

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
| `packages/connector/config/connector-a.yaml`        | live config (gitignored — `*.yaml` excluded, `*.yaml.example` included) |
| `packages/connector/config/connector-a.yaml.example`| template, committed |
| `packages/connector/config/connector-a.env`         | optional secrets (`TUNNEL_AUTH_TOKEN`, `CONNECTOR_VERSION`) |
| `packages/connector/config/connector-a.env.example` | template, committed |

`CONNECTOR_CONFIG` env var (default `config/connector-a.yaml`, **relative to `packages/connector/`** because run-connector.sh `cd`s there).

## Reconnect semantics

- WS close does **not** kill the connector process. It transitions the inspector to `closed` state and stops timers; the user can hit the reconnect button to redial.
- Reconnect re-reads the YAML. If `mcp_servers` changed, the connector logs a warning and uses the prior list (live MCP server reconnect is out of scope). `policy` changes take effect.
- Controller-side restarts (e.g. ngrok tunnel cycling) are handled by clicking reconnect.

## Process lifecycle gotcha

`scripts/run-connector.sh` spawns `sample-mcp-server` and `connector` as children. The script's pre-cleanup uses `pgrep -f 'scripts/run-connector\.sh'` and skips its own PID — do NOT replace this with `pkill -f` patterns that match `node dist/index.js`, because that catches unrelated node processes and does not catch orphan wrapper shells.

## OpenAI / LLM

There is no LLM client in this repo. If a future change brings one in, that's a strong signal something's drifting away from the productized design.

Historical note (preserved for any future LLM integration in *adjacent* code): `gpt-5.x` chat completions require `max_completion_tokens` (not `max_tokens`) and reject any `temperature` other than the default.

## Reference branch

The original PoC (in-shim LLM agent, document adapters, `can_answer`/`ask_procedure` tools) is preserved on the `poc-testing` branch. Do not look there for productized-connector patterns — it answers a different question.
