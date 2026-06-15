# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests. Per the productized design in `MCP-TUNNEL.md` (held outside this repo).

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

## Topology — one connector, many MCPs

The repo ships **one connector binary** (`packages/connector`) and **MCPs** under `mcp/` — split into `mcp/local/` (customer-authored, Type 1), `mcp/external/` (Type 2 config-only stubs), and `mcp/bundled/` (Twilio-authored, pre-installed in the connector image — can be **Type 1 or Type 3**). The folder marks *who ships it*; the YAML entry shape determines *how it's wired*. Today `mcp/bundled/twilio/` is a Type 1 (Node `server.ts` + per-folder `package.json` for the `twilio` SDK) and `mcp/bundled/enterprise-knowledge/` is a Type 3 (Python venv stub). Type 3 *source* lives at `bundles/<name>/` — deliberately outside `mcp/` so the runtime image only carries the installed venv (`/opt/bundled-mcps/<name>/.venv/`), not the build inputs (`pyproject.toml`, `src/`, `migrations/`). A single connector process reads one `packages/connector/connector.yaml` listing all MCPs and either spawns them as Type 1 children (auto-port), dials them as Type 2 endpoints, or launches Type 3 bundle entrypoints. In production this is one container per `connector_id`; in dev it's one local process.

Sample tools: `now`, `slow_echo`, `uuid`, `weather`. Orders: `get_recent`, `issue_refund`. Aviation-weather (Type 2 stdio): `wx_metar`, `wx_taf`, `wx_pireps`, `wx_sigmets`, `wx_icon_d2`, `wx_outlook`, `wx_preflight`, `wx_route`. Twilio (Type 1 under `mcp/bundled/twilio/`, yaml entry name `apis`): `messages_create`, `messages_fetch`, `messaging_services_fetch`, `content_templates_fetch`, `calls_create`, `calls_fetch`, `verify_send`, `verify_check`, `verify_services_fetch`, `lookups_fetch`. Enterprise Knowledge (Type 3 bundled stub): `sources_register`, `sources_fetch`, `sources_refresh`, `knowledge_query`.

The Twilio MCP previously lived in a sibling project `../twilio-mcp-shim/` that modeled the production deployment shape (Twilio runs its own connector, customer runs theirs). It has been re-folded into this repo at [`mcp/bundled/twilio/`](mcp/bundled/twilio/) so a single `./scripts/start-connector.sh` boots one connector that exposes both customer-side MCPs (`sample`, `crm`) and Twilio's own (`twilio`). It lives under `mcp/bundled/` because Twilio ships it in the connector image; it's wired as Type 1 because it's Node — there's no Python or venv involved. The sibling project is preserved as a reference for the original two-connector deployment shape but is no longer the source of truth.

The controller is **outside this repo** — this repo only ships the customer side.

### Three MCP integration patterns

- **Type 1 (customer-authored).** Folder under `mcp/local/<name>/` with `tools/*.ts` + `server.ts` (5 lines: import the SDK factory, list tools, call `createMcpHttpServer`). The yaml entry sets `transport: http` + `dir:` and **omits `endpoint`** — that's how the connector knows to spawn it. The spawner runs `tsx <dir>/server.ts` with `PORT=<auto-assigned>` (probe-bind from `MCP_BASE_PORT`, default 7100), waits for the TCP listener, then sets the spec's `endpoint` to `http://127.0.0.1:<port>/mcp` so the existing connect path works unchanged. No build step per MCP.
- **Type 2 (connect to existing MCP).** Pure config — yaml entry sets `transport: http` + `endpoint`, or `transport: stdio` + `command`. Optional `dir` (under `mcp/external/<name>/`) whose `.env` is loaded into the child's environment (handy for stdio servers that need API keys; ignored for Type 2 http unless future features wire it in). No customer-authored code needed.
- **Type 3 (bundled, Twilio-authored Python venv, pre-installed in this image).** Yaml entry sets `bundled: <name>` plus an optional `dir:` (under `mcp/bundled/<name>/`) for a per-bundle `.env`. The connector resolves `bundled:` against `BUNDLED_MCPS` in [packages/connector/src/config.ts](packages/connector/src/config.ts) — a registry of bundles laid down at image-build time under `/opt/bundled-mcps/<name>/`. Resolution synthesizes a stdio spec, so the rest of the spawner code is unchanged. Bundle source lives in **`bundles/<name>/`** at the repo root (separate from `mcp/` so the runtime image carries only the installed venv, not the build inputs); the connector's Dockerfile reads it during the bundle-build stage and `pip install`s it into the venv. Customer surface area: one yaml line + one `.env` file. No code, no `pip install` from the customer's side. Local-dev override: `BUNDLE_DEV_OVERRIDE_<UPPER_NAME>=/abs/path/to/launcher` redirects launch to a working tree (`scripts/start-connector.sh` auto-exports this for any bundle that ships a `dev-launch.sh`).

Note: a Twilio-authored MCP doesn't have to be Type 3. A Node MCP that needs a third-party SDK (e.g. `mcp/bundled/twilio/` shipping the `twilio` package) lives under `mcp/bundled/` *because Twilio ships it*, but is wired as Type 1 (yaml entry has `transport: http` + `dir:` and no `endpoint:`). Type 3 is specifically the Python+venv shape — use it when the bundle has its own non-Node deps that can't (or shouldn't) be hoisted into the connector workspace.

The detection helpers in [packages/connector/src/config.ts](packages/connector/src/config.ts) are `isType1Spawn(spec)` (http + dir + no endpoint) and `isType3Bundled(spec)` (stdio + bundled set). Type 3 resolution happens in `loadConfig` *before* the discriminated union parses, because `bundled:` entries have no `transport` field. Don't widen the classifiers without thinking through the cross-product with `sameMcpServers`'s reconnect-comparison logic — `bundled` is part of that equality check so an edit from `bundled: a` to `bundled: b` is detected even when both happen to resolve to identical commands.

### Adding a new MCP

Edit `packages/connector/connector.yaml` and add one entry. There is no per-folder `connector.yaml` any more. For Type 1, drop tools + `server.ts` under `mcp/local/<name>/`. For Type 2, just point at the endpoint or command; create a folder under `mcp/external/<name>/` only if the entry has its own `.env`. For Type 3, set `bundled: <name>` against a bundle that's already registered in `BUNDLED_MCPS`; supply only a `.env` in `mcp/bundled/<name>/`.

## Architecturally load-bearing properties

- **Outbound-only.** The connector opens **no inbound ports** for the tunnel. It dials out; the controller pushes RPC requests back down the same WS the connector opened.
- **Trust boundary is per MCP server, not per tool.** Every tool a server in `mcp_servers[]` exposes is forwarded to the controller. The customer controls *which* MCP servers run on their machine; that's the gate. We deliberately diverged from MCP-TUNNEL.md §"Configuration surface" (which prescribes a default-deny `allow_list.tools` block) — per-tool gating duplicated authority and forced a YAML edit on every new tool. Don't reintroduce `allow_list` without an explicit ask. The wire format keeps `ToolDescriptor.allowed` (controller may still display it; future enterprise-strict mode might use it) — the connector always sets it to `true`.
- **WS-handshake auth is per-tunnel, controller-minted.** The connector sends two headers on the `/mcp-tunnel` upgrade: `Authorization: Bearer <ts_…>` (the per-tunnel secret pasted from the controller's Tunnel Security UI) and `X-Connector-Name: <CONNECTOR_NAME>` (the lookup key — must match the row's Name field exactly, case-sensitive). The controller looks up the `tunnel_security_configs` row by `(tenant_id, name)` and bcrypt-compares the bearer; mismatch = HTTP 401. The legacy single-shared `TUNNEL_AUTH_TOKEN` env var on the controller is **gone, with no fallback** — every connector needs its own row, minted by an operator in **Tools → Connectors → Tunnel Security** after pasting Twilio AccountSid + AuthToken (or AccountSid + ApiKey). The controller verifies the credentials against Twilio's API at create time, then mints `ts_<rowId>_<random>` and shows it once. Rotate via the row's detail page — the previous hash remains valid for 24h via `secret_rotation_grace_until`. Both headers are wired in [packages/connector/src/tunnel/client.ts:64-66](packages/connector/src/tunnel/client.ts#L64-L66); `connectorName` threads from the constructor, sourced from `config.tunnel.name` in [packages/connector/src/index.ts:205](packages/connector/src/index.ts#L205).
- **Identity established at WS register-frame time.** Separate from the handshake: once the WS is up, the connector sends a `register` frame and the controller binds the session to a `connectors` row. On first connect the row is minted using `${CONNECTOR_NAME}` and the controller returns a `registrationToken` in the register-ack. The connector persists that token to `packages/connector/.connector-state.json` and presents it on every subsequent register frame. Strict mode: an unknown token is rejected (`unknown_registration_token`); the customer must clear the state file to mint fresh. The yaml uses `${CONNECTOR_NAME}` with no default — an unset env var fails fast at boot rather than silently binding to a placeholder. To re-mint under a new name: change `CONNECTOR_NAME` in `.env`, **also update or recreate the Tunnel Security row** so the new name has a matching bearer (the row is keyed on name), and delete `.connector-state.json`.
- **No LLM, no agent loop, no document handling — *in the connector core*.** The connector itself stays a thin dispatcher. Type 3 bundles are a deliberate exception: a bundled MCP child process can do whatever it needs (LlamaIndex, vector stores, document parsers) because it runs in its own venv, isolated from the connector's Node code path, with its own deps and its own per-entry `.env`. The rule applies to `packages/connector/`; it doesn't apply to what the connector spawns. If you find yourself adding `openai` or document-parser deps to `packages/connector/package.json`, stop — that belongs in a Type 3 bundle under `bundles/<name>/`, not here.

## Wire protocol — frames

Defined in [packages/connector/src/tunnel/frames.ts](packages/connector/src/tunnel/frames.ts):

- `register { manifest }` — first frame after WS open
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — sent on SIGTERM before WS close

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`. Some controllers also send a `register-ack` frame back; the connector parses and ignores it (non-spec, but harmless).

Each `ServerDescriptor` in the manifest carries an `author: string` field — derived by the connector from the spec, never configured. Today's values: `"twilio"` for any MCP under `mcp/bundled/` (resolved via `bundled:` yaml form *or* a `dir:` that lives under `mcp/bundled/`), `"customer"` for everything else. The controller uses this to group MCPs in its UI (e.g. Twilio-shipped vs customer-side MCPs in different sections of the connector detail view). Typed as `string` rather than a union literal so the controller forward-compats new author values without a wire-format break. The derivation lives in `authorOf(spec, yamlDir)` in [packages/connector/src/config.ts](packages/connector/src/config.ts) and is invoked once per server in [packages/connector/src/manifest/build.ts](packages/connector/src/manifest/build.ts) — change the rule there if the folder convention shifts.

## Workspaces

npm workspaces, **one package**: `@mcp-shim/connector`. That's the only thing that ships.

Type 1 MCPs are **not** workspaces, but every one carries a minimal `package.json` so it can grow third-party SDKs in isolation. The rule:

- **Framework deps (`zod`, `@mcp-shim/connector/sdk`)** are not listed per-folder. They resolve via Node's parent-dir walk to the workspace root `node_modules`, where npm hoists them once.
- **Third-party SDKs (`twilio`, future `axios`, `@salesforce/sf-cli`, etc.)** are declared in the MCP's own `package.json` `dependencies` block and install into that folder's `node_modules`. They never hoist to the workspace root, so other MCPs can't accidentally `import "twilio"`.

A folder's `package.json` may have an empty `dependencies` block (or none at all) when it imports only framework deps — `mcp/local/sample/` and `mcp/local/crm/` are like this today. The moment crm grows a Salesforce SDK, you add a `dependencies` block here listing that one SDK; nothing else changes. [`mcp/bundled/twilio/`](mcp/bundled/twilio/) is the live example of the third-party-SDK case (it lists `twilio` only).

`scripts/start-connector.sh` runs `npm install --omit=dev` in any MCP folder whose `package.json` has a non-empty `dependencies` block but is missing `node_modules` — first-boot is one-shot. The Dockerfile mirrors the same loop at image-build time. Bumping a dep *version* in `package.json` while `node_modules` already exists is a case the auto-install doesn't catch — run `npm install` in that folder yourself.

**Publish flip:** when `@mcp-shim/connector` is published to the npm registry (the `private: true` in [packages/connector/package.json](packages/connector/package.json) gets flipped), each Type 1 `package.json` will need to *also* list `"@mcp-shim/connector": "^<version>"` so the SDK resolves from the registry instead of the workspace. Today's hoist-from-workspace shape is the in-repo dev convenience; the registry pin is the customer-extracts-one-folder shape.

The `@mcp-shim/connector` package is publishable (`exports`, `bin`, and `name` are already set) — only `private: true` in [packages/connector/package.json](packages/connector/package.json) blocks publish. Flip when ready. The `twilio-mcp-shim` project consumes it via a `file:` dep in dev today; on publish, that flips to a registry pin with no consumer code change.

- **`packages/connector`** — the customer-side process. Config, MCP clients to local servers, WSS tunnel, dispatcher, spawner (Type 1 child supervisor), inspector UI, CLI (`start` / `init` / `discover` / `register` / `version`). The connector + its `tsx` runtime + the `mcp/` tree are what go in the OCI image.
- **`packages/connector/src/sdk/`** — the surface customer-authored Type 1 servers import. `Tool` interface + `createMcpHttpServer({name, tools, port?})` factory. Re-exported from `@mcp-shim/connector/sdk`.
- **`packages/connector/src/spawner.ts`** — auto-port probe + child supervisor for Type 1 entries. Resolves `tsx` from the connector's own `node_modules` (going via `tsx/package.json` because tsx's `exports` map blocks subpath access to `dist/cli.mjs`).
- **`mcp/local/sample`** — Type 1 demo. `tools/now.ts`, `slow-echo.ts`, `uuid.ts`, `weather.ts` (weather.gov, US-only) + a 5-line `server.ts`. No `package.json` deps; `zod` resolves to repo root.
- **`mcp/local/crm`** — Type 1 demo: thin client over the mock customer service at `mock/customers/`. Exposes `get_customer` (identity), `get_recent` (most-recent order), `issue_refund` (side-effect). Used by the Refund Eligibility procedure on the controller side.
- **`mcp/external/aviation-weather`** — Type 2 demo. Pure config — README + `.env.example` only. The yaml entry is `command: [npx, "--yes", aviation-weather-mcp]` and the connector spawns the published npm package via stdio.
- **`mcp/bundled/twilio`** — Twilio-authored Type 1. `server.ts` + `tools/*.ts` + `twilio-client.ts`, plus a per-folder `package.json` carrying the `twilio` SDK (kept local so it doesn't leak into the workspace). The connector spawns it via `tsx server.ts` like any other Type 1; it lives under `mcp/bundled/` because Twilio ships it pre-installed in the image, not because it's Type 3. Re-folded in from the prior `../twilio-mcp-shim/` sibling project.
- **`mcp/bundled/enterprise-knowledge`** — Type 3 config stub. Just a `.env.example`. Bundle *source* lives at [`bundles/enterprise-knowledge/`](bundles/enterprise-knowledge/); this folder exists so the customer's yaml can `dir: ../../mcp/bundled/enterprise-knowledge` and the standard per-entry `.env` loader picks up the customer's secrets without dragging the bundle's source into the runtime image.
- **`bundles/enterprise-knowledge`** — Type 3 source. Python package (`pyproject.toml`, `src/customer_ek_mcp/`, `migrations/`, `dev-launch.sh`). Read by `pip install` during the Dockerfile's bundle-build stage to populate `/opt/bundled-mcps/enterprise-knowledge/.venv/` in the runtime image; the source tree itself does *not* ship.

Type 1 servers use a stateful `StreamableHTTPServerTransport` with `randomUUID` session IDs. **Stateless mode does not work** with the SDK's HTTP transport — it requires a per-request transport instance. The factory in `sdk/http-server.ts` is the one place this is set up.

## CLI subcommands

[packages/connector/src/index.ts](packages/connector/src/index.ts) dispatches on `argv[0]`:

| Subcommand | Module | Notes |
|---|---|---|
| `start` (default) | `index.ts` `main()` | spawns Type 1 children, dials the tunnel; flags: `--config`, `--inspector-port`, `--no-inspector` |
| `init` | [packages/connector/src/init.ts](packages/connector/src/init.ts) | YAML wizard with Type 1 / Type 2 awareness; renders `dir:` paths relative to the yaml. Uses `node:readline` (no new deps) |
| `discover` | [packages/connector/src/discover.ts](packages/connector/src/discover.ts) | non-interactive `tools/list` per server, then exits |
| `version` | inline | prints `CONNECTOR_VERSION` or `dev` |

A startup boot log in `main()` prints `authToken: "set (len=N)"` after the auth-token presence check; if it's missing the connector throws and refuses to boot (symmetric with the `${CONNECTOR_NAME}` interpolation, which throws at YAML load if the env var is unset). Don't soften either check — the failure modes are intentional, and a silently-unauthenticated or unnamed connector is exactly the bug they prevent. Note: a `TUNNEL_AUTH_TOKEN` that's *set but doesn't match any controller row* boots fine here and gets rejected at the WS handshake with HTTP 401 — that's a controller-side decision (`bearer did not match any tunnel security config`), not something we can detect locally before dialing.

Logging is **Pino** ([packages/connector/src/logger.ts](packages/connector/src/logger.ts)) — pretty-printed in dev TTY, raw JSON in non-TTY (CI / `> log.txt` / Docker). Set `LOG_LEVEL=debug` to raise verbosity. Every component (`connector`, `dispatcher`, `inspector`, each Type 1 MCP, `mock-customers`) gets a child logger via `createLogger('component')`, and the bound `component:` field replaces the old `[component]` line prefixes. Type 1 MCP authors get the same logger via `import { createLogger } from "@mcp-shim/connector/sdk"`. Don't reintroduce `console.log` for runtime telemetry — CLI commands (`init`, `discover`, `--help` / `--version`) are the only place direct stdout writes belong, since their output is user-facing CLI text, not telemetry.

## Common commands

```bash
# Connector (workspace). Pulls in tsx (used by the spawner to run Type 1 children).
npm install
npm run build

# Every Type 1 folder carries its own package.json. Framework deps
# (zod, @mcp-shim/connector/sdk) resolve up to the workspace root, so
# folders that only import those (sample, crm today) need no install.
# Folders that declare third-party SDK deps (twilio today) get them
# installed by start-connector.sh on first boot, into their own
# node_modules — never hoisted to the workspace root.

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
| `packages/connector/.env`                   | live tunnel env: `CONTROLLER_URL` (HTTPS root, e.g. `https://controller.example.com`), `CONNECTOR_NAME` (must match the controller's Tunnel Security row), `TUNNEL_AUTH_TOKEN` (the `ts_…` bearer minted by that row), optional `INSPECTOR_PORT` / `MCP_BASE_PORT`. Gitignored. |
| `packages/connector/.connector-state.json`  | written by the connector on first register-ack; carries `registrationToken`. Customer never edits; clearing it forces a re-mint. Gitignored. |

`CONTROLLER_URL` is the controller's HTTPS root; it's used for both the register API call and the WS tunnel dial. The connector internally upgrades `https://` → `wss://` and appends the `/mcp-tunnel` path in [packages/connector/src/tunnel/client.ts](packages/connector/src/tunnel/client.ts) before opening the socket. Don't expose the wire scheme or path as a customer-facing config knob — keep it as `https://<host>` everywhere customers touch and let the connector do the upgrade. The controller dispatches `/crelay` (Conversation Relay) and `/mcp-tunnel` on a single port (default 3001), so one DNS entry / one ngrok tunnel covers both.
| `packages/connector/.env.example`           | template, committed. |
| `mcp/{local,external,bundled}/<name>/.env`         | per-MCP live env. Loaded by the connector into *that child's* process only — never leaks across MCPs. Gitignored. |
| `mcp/{local,external,bundled}/<name>/.env.example` | per-MCP template, committed. |

The YAML supports `${VAR}` and `${VAR:-default}` interpolation; unknown vars without a default throw with the variable name and YAML line so the customer can fix the right line. `start-connector.sh` sources `packages/connector/.env` and invokes `node packages/connector/dist/index.js start`. The connector handles registration inline: on the first WS register frame it presents `tunnel.name`, the controller mints a row + token, the connector persists the token in `.connector-state.json`. Subsequent restarts present the token and re-bind to the same row — no separate provisioning step. In Docker, set the same vars via container env — there is no `.env` inside the image; the customer mounts `connector.yaml` at `CONNECTOR_CONFIG` (default `/etc/mcp-connector/config.yaml`) and a writable volume for `.connector-state.json` (or accepts re-mint on every restart, which the controller's dup-name guard catches). The image bundles `mcp/` at `/app/mcp/` for Type 1 entries to spawn from and Type 2/3 `dir:` resolution.

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

[packages/connector/Dockerfile](packages/connector/Dockerfile) is multi-stage; runtime image carries the connector's `dist/` + `public/` + production `node_modules` (incl. `tsx`) + the `mcp/` tree + Python venvs for Type 3 bundles under `/opt/bundled-mcps/<name>/`. The `mcp/` tree is bundled because Type 1 entries in `connector.yaml` reference them via `dir:` and the spawner must be able to `tsx <dir>/server.ts`. Customers who want their own Type 1 MCPs extend the image with additional folders under `/app/mcp/local/`.

The build stage runs `npm install --omit=dev --no-package-lock` inside any `mcp/local/*/`, `mcp/external/*/`, or `mcp/bundled/*/` that has a non-empty `dependencies` block. Today only `mcp/bundled/twilio/` matches (it ships the `twilio` SDK locally). Folders whose `package.json` only declares the MCP's identity (sample, crm) skip cleanly — `zod` and `@mcp-shim/connector/sdk` resolve up to `/app/node_modules` from the hoisted workspace install. Folders without any `package.json` at all (aviation-weather, enterprise-knowledge — neither has Node code in this repo) skip too.

[scripts/build-image.sh](scripts/build-image.sh) defaults to `linux/amd64,linux/arm64` (Graviton + ARM Macs). Per-cloud guides at [docs/deploy/](docs/deploy/) (AWS Fargate, Azure Container Apps, GCP GKE) document the foot-guns of each platform — most importantly, **don't put a load balancer in front of the connector** (nothing inbound) and **don't use Cloud Run / App Service / scale-to-zero anything** (kills the WSS).

## OpenAI / LLM

There is no LLM client in this repo. If a future change brings one in, that's a strong signal something's drifting away from the productized design.

Historical note (preserved for any future LLM integration in *adjacent* code): `gpt-5.x` chat completions require `max_completion_tokens` (not `max_tokens`) and reject any `temperature` other than the default.

## Reference branch

The original PoC (in-shim LLM agent, document adapters, `can_answer`/`ask_procedure` tools) is preserved on the `poc-testing` branch. Do not look there for productized-connector patterns — it answers a different question.
