# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests. Per the productized design in `MCP-TUNNEL.md` (held outside this repo).

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

## Topology — one connector, many MCPs

The repo ships **one connector binary** (`packages/connector`) and **demo MCPs** under `examples/`. A single connector process reads one `packages/connector/connector.yaml` listing all MCPs and either spawns them as Type 1 children (auto-port) or dials them as Type 2 endpoints. In production this is one container per `connector_id`; in dev it's one local process.

Sample tools: `now`, `slow_echo`, `uuid`, `weather`. Orders: `get_recent`, `issue_refund`. Aviation-weather (Type 2 stdio): `wx_metar`, `wx_taf`, `wx_pireps`, `wx_sigmets`, `wx_icon_d2`, `wx_outlook`, `wx_preflight`, `wx_route`.

The Twilio-authored MCP that used to live here as `examples/twilio-mcp-server/` has moved out to a sibling project `../twilio-mcp-shim/`, which models the production deployment shape (Twilio runs its own connector, customer runs theirs — see [README](README.md)). Don't reintroduce a Twilio MCP under `examples/` without an explicit ask.

The controller is **outside this repo** — this repo only ships the customer side.

### Two MCP integration patterns

- **Type 1 (customer-authored).** Folder under `examples/<name>/` with `tools/*.ts` + `server.ts` (5 lines: import the SDK factory, list tools, call `createMcpHttpServer`). The yaml entry sets `transport: http` + `dir:` and **omits `endpoint`** — that's how the connector knows to spawn it. The spawner runs `tsx <dir>/server.ts` with `PORT=<auto-assigned>` (probe-bind from `MCP_BASE_PORT`, default 7100), waits for the TCP listener, then sets the spec's `endpoint` to `http://127.0.0.1:<port>/mcp` so the existing connect path works unchanged. No build step per example.
- **Type 2 (connect to existing MCP).** Pure config — yaml entry sets `transport: http` + `endpoint`, or `transport: stdio` + `command`. Optional `dir` whose `.env` is loaded into the child's environment (handy for stdio servers that need API keys; ignored for Type 2 http unless future features wire it in). No customer-authored code needed.

The detection helper is [packages/connector/src/config.ts](packages/connector/src/config.ts) `isType1Spawn(spec)` — `http` transport + `dir` set + no `endpoint`. Don't widen this without thinking through the cross-product with sameMcpServers's reconnect-comparison logic.

### Adding a new MCP

Edit `packages/connector/connector.yaml` and add one entry. There is no per-folder `connector.yaml` any more. For Type 1, drop tools + `server.ts` under `examples/<name>/`. For Type 2, just point at the endpoint or command; no folder needed unless the entry has its own `.env`.

## Architecturally load-bearing properties

- **Outbound-only.** The connector opens **no inbound ports** for the tunnel. It dials out; the controller pushes RPC requests back down the same WS the connector opened.
- **Trust boundary is per MCP server, not per tool.** Every tool a server in `mcp_servers[]` exposes is forwarded to the controller. The customer controls *which* MCP servers run on their machine; that's the gate. We deliberately diverged from MCP-TUNNEL.md §"Configuration surface" (which prescribes a default-deny `allow_list.tools` block) — per-tool gating duplicated authority and forced a YAML edit on every new tool. Don't reintroduce `allow_list` without an explicit ask. The wire format keeps `ToolDescriptor.allowed` (controller may still display it; future enterprise-strict mode might use it) — the connector always sets it to `true`.
- **Identity established at WS register-frame time.** The yaml carries `tunnel.name`; on first connect the controller mints a row keyed by name and returns a `registrationToken` in the register-ack. The connector persists that token to `packages/connector/.connector-state.json` and presents it on every subsequent register frame so the controller binds to the same row. Strict mode: an unknown token is rejected (`unknown_registration_token`); the customer must clear the state file to mint fresh. There is no `CONNECTOR_ID` env var — identity lives in `tunnel.name` (yaml, customer-chosen) and the state file (token, controller-issued).
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

Type 1 examples under `examples/` are deliberately **not** workspaces. They have no `package.json` at all — `zod` and `@mcp-shim/connector/sdk` resolve up to the repo-root `node_modules`. An example that needs a third-party SDK should carry its own minimal `package.json` + `node_modules` to keep that dep out of the workspace install graph; today no example in this repo does. The sibling `../twilio-mcp-shim/` project demonstrates the third-party-SDK case for a Twilio-authored deployment.

The `@mcp-shim/connector` package is publishable (`exports`, `bin`, and `name` are already set) — only `private: true` in [packages/connector/package.json](packages/connector/package.json) blocks publish. Flip when ready. The `twilio-mcp-shim` project consumes it via a `file:` dep in dev today; on publish, that flips to a registry pin with no consumer code change.

- **`packages/connector`** — the customer-side process. Config, MCP clients to local servers, WSS tunnel, dispatcher, spawner (Type 1 child supervisor), inspector UI, CLI (`start` / `init` / `discover` / `register` / `version`). The connector + its `tsx` runtime + the bundled `examples/` are what go in the OCI image.
- **`packages/connector/src/sdk/`** — the surface customer-authored Type 1 servers import. `Tool` interface + `createMcpHttpServer({name, tools, port?})` factory. Re-exported from `@mcp-shim/connector/sdk`.
- **`packages/connector/src/spawner.ts`** — auto-port probe + child supervisor for Type 1 entries. Resolves `tsx` from the connector's own `node_modules` (going via `tsx/package.json` because tsx's `exports` map blocks subpath access to `dist/cli.mjs`).
- **`examples/sample-mcp-server`** — Type 1 demo. `tools/now.ts`, `slow-echo.ts`, `uuid.ts`, `weather.ts` (weather.gov, US-only) + a 5-line `server.ts`. No `package.json` deps; `zod` resolves to repo root.
- **`examples/orders-mcp-server`** — Type 1 demo with in-memory order fixtures used by the Refund Eligibility procedure on the controller side.
- **`examples/aviation-weather-mcp`** — Type 2 demo. Pure config — README + `.env.example` only. The yaml entry is `command: [npx, "--yes", aviation-weather-mcp]` and the connector spawns the published npm package via stdio.

Type 1 servers use a stateful `StreamableHTTPServerTransport` with `randomUUID` session IDs. **Stateless mode does not work** with the SDK's HTTP transport — it requires a per-request transport instance. The factory in `sdk/http-server.ts` is the one place this is set up.

## CLI subcommands

[packages/connector/src/index.ts](packages/connector/src/index.ts) dispatches on `argv[0]`:

| Subcommand | Module | Notes |
|---|---|---|
| `start` (default) | `index.ts` `main()` | spawns Type 1 children, dials the tunnel; flags: `--config`, `--inspector-port`, `--no-inspector` |
| `init` | [packages/connector/src/init.ts](packages/connector/src/init.ts) | YAML wizard with Type 1 / Type 2 awareness; renders `dir:` paths relative to the yaml. Uses `node:readline` (no new deps) |
| `discover` | [packages/connector/src/discover.ts](packages/connector/src/discover.ts) | non-interactive `tools/list` per server, then exits |
| `version` | inline | prints `CONNECTOR_VERSION` or `dev` |

A startup boot log in `main()` prints `auth_token=set (len=N) | absent` so a silently-unauthenticated connector is impossible to miss. Don't remove it.

## Common commands

```bash
# Connector (workspace). Pulls in tsx (used by the spawner to run Type 1 children).
npm install
npm run build

# All Type 1 examples in this repo (sample, orders) have no per-folder
# package.json — zod and the SDK resolve from repo root, so no per-example
# install step is needed. (Examples that DO need a third-party SDK should
# install in their own folder; today the productized example of that
# pattern lives in the sibling ../twilio-mcp-shim/ project.)

# Connector-level env + yaml — single yaml lists every MCP.
cp packages/connector/.env.example packages/connector/.env
cp packages/connector/connector.yaml.example packages/connector/connector.yaml

./scripts/start-connector.sh
```

First boot auto-registers over the WS tunnel (using `tunnel.name` from the yaml) and writes `registrationToken` to `.connector-state.json`. Subsequent boots reconnect by token. There is no separate provisioning step.

Inspector UI: <http://localhost:9090/>. There's only one inspector per connector now (one connector boots all MCPs).

A Type 1 entry whose child crashes on boot (e.g. an MCP that requires API creds and gets empty values) fails-fast at the spawner readiness probe — by design. The fix is to either provide the creds in the entry's `dir/.env`, or comment the entry out of `connector.yaml`.

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
| `packages/connector/connector.yaml`         | live, single source of truth for this connector. Lists every MCP. Carries `tunnel.name` (customer-chosen, identity claim) and references `${CONTROLLER_URL}`, `${TUNNEL_AUTH_TOKEN}`. Gitignored. |
| `packages/connector/connector.yaml.example` | template, committed. |
| `packages/connector/.env`                   | live, shared tunnel env: `CONTROLLER_URL` (HTTPS root, e.g. `https://controller.example.com`), `TUNNEL_AUTH_TOKEN`, optional `INSPECTOR_PORT` / `MCP_BASE_PORT`. Gitignored. |
| `packages/connector/.connector-state.json`  | written by the connector on first register-ack; carries `registrationToken`. Customer never edits; clearing it forces a re-mint. Gitignored. |

`CONTROLLER_URL` is the controller's HTTPS root; it's used for both the register API call and the WS tunnel dial. The connector internally upgrades `https://` → `wss://` and appends the `/mcp-tunnel` path in [packages/connector/src/tunnel/client.ts](packages/connector/src/tunnel/client.ts) before opening the socket. Don't expose the wire scheme or path as a customer-facing config knob — keep it as `https://<host>` everywhere customers touch and let the connector do the upgrade. The controller dispatches `/crelay` (Conversation Relay) and `/mcp-tunnel` on a single port (default 3001), so one DNS entry / one ngrok tunnel covers both.
| `packages/connector/.env.example`           | template, committed. |
| `examples/<name>/.env`                      | per-MCP live env. Loaded by the connector into *that child's* process only — never leaks across MCPs. Gitignored. |
| `examples/<name>/.env.example`              | per-MCP template, committed. |

The YAML supports `${VAR}` and `${VAR:-default}` interpolation; unknown vars without a default throw with the variable name and YAML line so the customer can fix the right line. `start-connector.sh` sources `packages/connector/.env` and invokes `node packages/connector/dist/index.js start`. The connector handles registration inline: on the first WS register frame it presents `tunnel.name`, the controller mints a row + token, the connector persists the token in `.connector-state.json`. Subsequent restarts present the token and re-bind to the same row — no separate provisioning step. In Docker, set the same vars via container env — there is no `.env` inside the image; the customer mounts `connector.yaml` at `CONNECTOR_CONFIG` (default `/etc/mcp-connector/config.yaml`) and a writable volume for `.connector-state.json` (or accepts re-mint on every restart, which the controller's dup-name guard catches). The image bundles `examples/` at `/app/examples/` for Type 1 entries to spawn from.

### Per-entry env precedence (subtle)

The plan called this out as the highest-risk piece — read carefully before changing it:

1. `dotenv/config` loads `packages/connector/.env` once at startup → populates `process.env`.
2. `loadConfig` parses the yaml. Top-level `${VAR}` interpolation reads from `process.env` only.
3. For each `mcp_servers[]` entry with `dir:`, the loader reads `<dir>/.env` into a **per-spec env map** (does **not** mutate `process.env`).
4. When the spawner launches a Type 1 child or stdio.ts launches a Type 2 stdio child, it merges `{...process.env, ...spec.env, PORT: ...}` and passes it as the child's environment. Cross-entry leakage is impossible — child A's `API_TOKEN` does not reach child B even if both `.env` files declare the same var name.

Don't replace the per-spec env map with calls to `dotenv.config({path: ...})` in `loadConfig` — that mutates `process.env` and breaks the isolation guarantee.

In production, each connector deployment is its own container — same yaml shape, just one container per `tunnel.name`.

## Reconnect semantics

- WS close does **not** kill the connector process. It transitions the inspector to `closed` state and stops timers.
- Auto-reconnect is **on by default** (`policy.reconnect.enabled: true`). On an unexpected close the connector schedules a redial via `scheduleAutoReconnect()` in `index.ts` and the inspector enters a fourth `reconnecting` state showing "reconnecting in N.Ns · attempt K". A successful register-ack resets the attempt counter. SIGTERM/SIGINT and a manual click on the inspector's Reconnect button both cancel any pending auto-reconnect timer (`cancelAutoReconnect()`) so a manual click fires immediately.
- Auto-reconnect is **suppressed when the controller rejects the register frame** (e.g. `unknown_registration_token` after the controller's connector row was deleted or the DB was reset). The connector sets a `registrationRejected` flag in the `register-ack` handler; the next `onclose` logs `auto-reconnect suppressed` and stays in `closed` instead of looping forever on a token the controller already said it doesn't recognize. The operator's recovery is to clear `.connector-state.json` and click Reconnect — the manual reconnect path clears the flag, so the next attempt re-mints a fresh row.
- Backoff is computed by `nextReconnectDelay(attempt, policy)` at the bottom of `index.ts`. Today it returns a fixed delay (= `initial_backoff_ms`); swapping in a real backoff curve (full jitter / decorrelated jitter / etc.) is a localized change that doesn't touch the rest of the loop.
- Set `policy.reconnect.enabled: false` to opt out — useful in deployed containers where the orchestrator (Fargate / Container Apps / GKE) is the supervisor and you want the inspector to surface a hard `closed` state. With auto-reconnect disabled, behavior matches the original PoC: `closed` until a manual click or SIGHUP.
- Reconnect re-reads the YAML. `sameMcpServers()` in `index.ts` compares name + transport + endpoint + command + dir + env across the prior and new lists. If anything in `mcp_servers` changed, the connector logs a warning and uses the prior list (live MCP server reconnect is out of scope — the spawned children, the stdio transport, the per-entry env are all wired at boot). `policy` changes take effect.
- Controller-side restarts (e.g. ngrok tunnel cycling) are recovered automatically; the inspector pill flips through closed → reconnecting → connecting → open as the controller comes back. No action required.

## Process lifecycle gotcha

`scripts/start-connector.sh` boots one connector process; the connector itself spawns Type 1 children. The script's pre-cleanup uses `pgrep -f 'scripts/start-connector\.sh'` and skips its own PID — do NOT replace this with `pkill -f` patterns that match `node dist/index.js`, because that catches unrelated node processes and does not catch orphan wrapper shells. The pgrep pattern must match the script's filename — if you rename the file, update the pattern in the same change or the pre-cleanup silently misses prior runs.

The connector's SIGTERM handler calls `shutdownChildren()` which sends SIGTERM to every Type 1 child it spawned. Combined with the script's `trap cleanup EXIT INT TERM` (which `kill 0`s the process group), Ctrl-C cleans up the whole tree.

## Distribution

Primary shape is a signed multi-arch OCI image. Build:

```bash
./scripts/build-image.sh                                # local single-arch
IMAGE=registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh  # multi-arch + push
```

[packages/connector/Dockerfile](packages/connector/Dockerfile) is multi-stage; runtime image carries the connector's `dist/` + `public/` + production `node_modules` (incl. `tsx`) + the `examples/` tree. The examples are bundled because Type 1 entries in `connector.yaml` reference them via `dir:` and the spawner must be able to `tsx <dir>/server.ts`. Customers who want their own Type 1 MCPs extend the image with additional folders under `/app/examples/`.

The build stage runs `npm install --omit=dev --no-package-lock` inside any `examples/*/` that has a non-empty `dependencies` block (today: none — the `for` loop is a no-op until someone drops in a Type 1 example with its own SDK). Examples without `package.json` (sample, orders) need nothing extra — `zod` and `@mcp-shim/connector/sdk` resolve up to `/app/node_modules`.

[scripts/build-image.sh](scripts/build-image.sh) defaults to `linux/amd64,linux/arm64` (Graviton + ARM Macs). Per-cloud guides at [docs/deploy/](docs/deploy/) (AWS Fargate, Azure Container Apps, GCP GKE) document the foot-guns of each platform — most importantly, **don't put a load balancer in front of the connector** (nothing inbound) and **don't use Cloud Run / App Service / scale-to-zero anything** (kills the WSS).

## OpenAI / LLM

There is no LLM client in this repo. If a future change brings one in, that's a strong signal something's drifting away from the productized design.

Historical note (preserved for any future LLM integration in *adjacent* code): `gpt-5.x` chat completions require `max_completion_tokens` (not `max_tokens`) and reject any `temperature` other than the default.

## Reference branch

The original PoC (in-shim LLM agent, document adapters, `can_answer`/`ask_procedure` tools) is preserved on the `poc-testing` branch. Do not look there for productized-connector patterns — it answers a different question.
