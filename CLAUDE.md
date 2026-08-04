# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests.

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

The controller is **outside this repo** — this repo only ships the customer side.

## Topology — one connector, many MCPs

The repo ships **one connector binary** (`connector`) and MCPs under two roots:

- `customer-mcps/` — customer-authored (Type 1). Empty at ship time; customers populate via derived image or volume mount.
- `bundled-mcps/` — Twilio-authored bundles pre-installed in the connector image. Today: `agentic-memory` (Type 1 Node drop-in), `enterprise-knowledge` (Type 3 Python venv stub).

A single connector process: (a) reads `./connector.yaml` (resolved from CWD — repo root in dev, `/etc/mcp-connector/` or the customer's mounted config path in production) for yaml-managed MCPs; (b) auto-discovers customer-authored drop-in MCPs under `${MCP_DROPIN_DIR}/<name>/tools/*.ts` at boot or via runtime rescan; (c) receives a controller-pushed roster of Type 2 (3rd-party) MCPs over the WSS tunnel — where Twilio + Segment arrive today (see "v1.1 — 3rd-party MCP roster" in [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md)).

In production this is one container per `connector_id`; in dev, one local process.

In-repo demos: `examples/demos/sample/` (Type 1 drop-in — `now`, `slow_echo`, `uuid`, `weather`, plus prompts + resources), `examples/demos/crm/` (Type 1 drop-in — 9 tools incl. write endpoints, 3 prompts, 1 resource; consumes `examples/mock-backend/` via `MOCK_CUSTOMERS_URL`). Reference mock backend: `examples/mock-backend/` (Postgres-backed customer store, deploys as its own private-only Fly sibling app).

### Three MCP integration patterns

- **Type 1 (customer-authored, drop-in shape — default).** Folder under `customer-mcps/<name>/tools/` (and optionally `prompts/`, `resources/`) with `*.ts` files only. No `server.ts`, no `package.json`, no yaml entry, no `.env` (creds come from the controller). The drop-in scanner at [connector/src/dropin.ts](connector/src/dropin.ts) discovers the folder at boot; the synthesized child runtime at [connector/src/sdk/dropin-runner.ts](connector/src/sdk/dropin-runner.ts) wires each default-exported `Tool` / `Prompt` / `Resource` into a per-folder subprocess (`tsx dropin-runner.js` with `DROPIN_DIR=<folder> DROPIN_NAME=<name> PORT=<auto-assigned>`; auto-port probe from `MCP_BASE_PORT`, default 7100). Folder name = MCP name. Walkthrough at [docs/AUTHOR-LOCAL-MCP.md](docs/AUTHOR-LOCAL-MCP.md). Runtime refresh (no process restart): controller UI **Refresh local MCPs** → `local-mcps-rescan` frame → connector re-runs the scanner; loopback-only mirror at `/mcp/rescan-local` on the inspector. Drop-ins are **approval-gated** — the connector spawns and lists but withholds tools from the manifest until `mcp-enable` arrives (see approval gate under "Load-bearing properties").

  **Type 1 hand-written shape (legacy escape hatch).** Folder with its own `server.ts` (imports the SDK factory, lists tools, calls `createMcpHttpServer`) plus a yaml entry with `transport: http` + `dir:` + no `endpoint:`. Yaml + hand-written `server.ts` win over drop-in discovery for the same folder name. Stays available for Type 1 MCPs shipping their own `package.json` (third-party SDK that can't hoist to the workspace); no in-repo MCP uses it today. `MCP_DROPIN_DIR` defaults to `/var/lib/mcp-connector/customer-mcps/` in production; `scripts/start-connector.sh` exports `$ROOT/customer-mcps` for dev. Runtime rescan reconciliation lives in [connector/src/tunnel/local-mcps-coordinator.ts](connector/src/tunnel/local-mcps-coordinator.ts) — single-flight, filters by `source === "local"` so yaml + controller-config entries are immune.

- **Type 2 (connect to existing MCP) — controller-pushed.** No yaml. The operator adds the MCP through the controller UI (Name, Transport, URL or command, Auth shape); the controller pushes it to this connector via `mcp-config-snapshot` / `mcp-config-delta` per [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) v1.1. The roster lives in connector RAM only (no yaml rewrite, no on-disk persistence — every **process restart** rebuilds from a fresh snapshot; WS reconnect is NOT a reset — see [`McpConfigCoordinator`](connector/src/tunnel/mcp-config-coordinator.ts)'s LIFETIME block). The supervisor + `servers/` connect path handle Type 2 entries identically whether they came from yaml (transitional) or the controller (target state). Auth on outbound HTTP-family calls is attached via `spec.headers`; stdio Type 2 entries receive creds via env, same as today.

- **Type 3 (bundled, Twilio-authored Python venv, pre-installed in image).** Yaml entry sets `bundled: <name>` plus an optional `dir:` (under `bundled-mcps/<name>/`) for a per-bundle `.env`. The connector resolves `bundled:` against `BUNDLED_MCPS` in [connector/src/config.ts](connector/src/config.ts) — a registry of bundles laid down at image-build time under `/opt/bundled-mcps/<name>/`. Resolution synthesizes a stdio spec, so the rest of the supervisor code is unchanged. Bundle source lives in **`bundled-mcps/<name>/source/`** (separate from the runtime folder so the image carries only the installed venv, not the build inputs); the connector's Dockerfile reads it during the bundle-build stage and `pip install`s it into the venv. Customer surface area: one yaml line + one `.env` file. Local-dev override: `BUNDLE_DEV_OVERRIDE_<UPPER_NAME>=/abs/path/to/launcher` redirects launch to a working tree (`scripts/start-connector.sh` auto-exports this for any bundle that ships a `dev-launch.sh`).

Type 3 is specifically the Python+venv shape — use it when a bundle has non-Node deps that can't (or shouldn't) hoist into the connector workspace. A Node bundle Twilio ships would still be Type 1 (yaml entry has `transport: http` + `dir:` and no `endpoint:`).

The detection helpers in [connector/src/config.ts](connector/src/config.ts) are `isType1Spawn(spec)` (http + dir + no endpoint) and `isType3Bundled(spec)` (stdio + bundled set). Type 3 resolution happens in `loadConfig` *before* the discriminated union parses, because `bundled:` entries have no `transport` field. Don't widen the classifiers without thinking through the cross-product with `sameMcpServers`'s reconnect-comparison logic — `bundled` is part of that equality check.

## Architecturally load-bearing properties

- **Outbound-only.** The connector opens **no inbound ports** for the tunnel. It dials out; the controller pushes RPC requests back down the same WS the connector opened.

- **Trust boundary is per MCP server, not per tool.** Every tool a server in `mcp_servers[]` exposes is forwarded to the controller. The customer controls *which* MCP servers run on their machine; that's the gate. The wire format keeps `ToolDescriptor.allowed` (controller may still display it) — the connector always sets it to `true`. Don't reintroduce per-tool `allow_list` without an explicit ask; it duplicated authority and forced a YAML edit on every new tool.

- **Manifest builds degrade per-MCP-server, not globally.** A single MCP's `tools/list` failure yields `tools: []` for that descriptor; the rest of the manifest still ships. Matches the existing `safeList()` behavior for prompts/resources/templates and the trust-boundary-is-per-server property. Enforced at [`connector/src/manifest/build.ts`](connector/src/manifest/build.ts); pinned by [`connector/tests/manifest/build-resilience.test.ts`](connector/tests/manifest/build-resilience.test.ts). Don't reintroduce a global `Promise.all` failure mode for any list method.

- **Customer drop-ins gated by controller approval.** A drop-in folder under `${MCP_DROPIN_DIR}` is a *proposal*, not an *acceptance*. The connector spawns the child and lists tools, but withholds the tools from the manifest and emits `mcp-discovered`. The controller's operator approval gesture is what flips the tools into the manifest via `mcp-enable`. Two-key model: the customer admin's filesystem write access proposes; the controller operator's approval click accepts. Yaml-listed Type 1 / Type 3 / 3rd-party MCPs are NOT gated (yaml or controller-UI-authored = pre-existing acceptance). The approved-set lives in connector RAM only — controller replays `mcp-enable` after every `register-ack` to restore state. Don't add approval persistence to the state file — the controller is the source of truth by design. Gate predicate: `author === "customer" && source === "local"`.

- **Schema declaration follows the trust boundary.** Tools we author (Type 1 customer-side, Type 3 Twilio bundles) declare `outputSchema` so controller-side procedure authors can write `{{ hydrate:<server>.<tool>.<field> }}` and have it type-checked. Tools we don't author (Type 2 externals) pass through verbatim — the controller handles missing schemas gracefully. The boot-time check at [`connector/src/manifest/validate.ts`](connector/src/manifest/validate.ts) logs `error` per offending Type 1 / Type 3 tool but does NOT throw — a missing schema is a per-tool bug, not a connector-wide failure. See [`connector/README.md`](connector/README.md) "Author a Type 1 MCP" for the five authoring rules.

- **WS-handshake auth is per-tunnel, controller-minted.** The connector sends `Authorization: Bearer <bearer>` and `X-Connector-Name: <name>` on the `/mcp-tunnel` upgrade. The bearer's ID prefix (`ts_tsec<rowId>_...`) locates the `tunnel_security_configs` row; the hash tail proves ownership. Mismatch → HTTP 401. Posture is DB-driven and mutually exclusive — boot fails if neither is configured. Header build at [connector/src/tunnel/client.ts](connector/src/tunnel/client.ts) branches:

  | Posture | Trigger | Rotation |
  |---------|---------|----------|
  | Static bearer (`ts_<rowId>_<random>`) | `oauth_client_id` unset | Row's **Rotate Secret** button, prior hash 24h grace |
  | OAuth2 `client_credentials` | `oauth_client_id` set | Connector mints 1h JWT, refreshes <60s before expiry; provider cached in [`auth/oauth-provider.ts`](connector/src/auth/oauth-provider.ts) survives WS reconnect |

  Twilio-takeover for OAuth2 deployments is `oauth_token_url` flip from controller to `https://oauth.twilio.com/v2/token` with no connector code change.

- **Identity established at WS register-frame time.** Separate from the handshake: once the WS is up, the connector sends a `register` frame and the controller binds the session to a `connectors` row. On first connect the row is minted using the resolved connector name and the controller returns a `registrationToken` in the register-ack. The connector persists that token to the sealed `controllers.registration_token_ct` column and presents it on every subsequent register frame. An unknown token is rejected (`unknown_registration_token`); the frame-router self-heals by clearing the token via the `onTokenCleared` callback (wired to `store.clearRegistrationToken`) and letting auto-reconnect re-mint. Identity + creds are configured entirely via the inspector's Configure Tunnel modal — no env vars.

- **No LLM, no agent loop, no document handling — *in the connector core*.** The connector itself stays a thin dispatcher. Type 3 bundles are a deliberate exception: a bundled MCP child process can do whatever it needs (LlamaIndex, vector stores, document parsers) because it runs in its own venv, isolated from the connector's Node code path, with its own deps and per-entry `.env`. The rule applies to `connector/`; it doesn't apply to what the connector spawns. If you find yourself adding `openai` or document-parser deps to `connector/package.json`, stop — that belongs in a Type 3 bundle under `bundled-mcps/<name>/source/`.

- **Webhook ingress preserves the outbound-only invariant.** The public URL lives on the *controller* (`https://<controller-host>/api/webhook/<connectorId>/<token>`); the connector consumes events as `webhook` frames over the existing `/mcp-tunnel` WS. The connector opens **no** inbound port for webhook ingress, no per-MCP ngrok, no LB. Every webhook URL is bcrypt-protected per (connectorId, mcp); the URL prefix (rowId) is stable across reconnects but the random tail re-mints on every `webhook-allocate` — the connector pushes the new value to SDK consumers as a fresh `event: url` over the inspector loopback's SSE stream (see [`connector/src/tunnel/webhook-registry.ts`](connector/src/tunnel/webhook-registry.ts)). Don't reintroduce a per-MCP local listener for webhook delivery.

- **Inspector port is localhost-only and carries copy-able webhook URLs.** The inspector at `INSPECTOR_PORT` (default 9090) hosts both the operator UI *and* the SDK ↔ connector IPC routes (`/internal/webhook/stream`, `/internal/webhook/revoke`) used by bundled MCP children to subscribe to webhook events. The Webhooks panel exposes the full bcrypt-protected URL with a copy button by design. **Never bridge `INSPECTOR_PORT` to a public load balancer** — copying the URL out is intentional, and that URL *is* the secret.

- **Inspector session creds are loopback-only, in-memory, and write-only on the wire.** The routes `POST /mcp/session-creds-apply` and `POST /mcp/session-creds-clear` accept developer-pasted env values for an MCP; `GET /mcp/env-keys?mcp=<name>` lists declared key names (read-only, never values). Values land in the supervisor's private `entry.sessionEnv`, never persist to disk, never echo back through the loopback UI, and never cross to the controller. They expire 12h after paste (hard cap, not sliding-on-activity) — the supervisor's per-MCP `setTimeout` clears them and restarts the child without the value. Merge precedence is `process.env ⊕ spec.env ⊕ sessionEnv ⊕ controllerEnv` — controller wins per-key, session creds fill *gaps* the controller hasn't covered. There is no `GET /mcp/session-creds` and there never will be. Leak channels pinned by [`connector/tests/inspector/session-creds-leak.test.ts`](connector/tests/inspector/session-creds-leak.test.ts) and [`connector/tests/logger/redact.test.ts`](connector/tests/logger/redact.test.ts); pino has a `redact.paths` allowlist as runtime backstop. Customer-facing reference at [docs/INSPECTOR.md](docs/INSPECTOR.md) §"Right pane — MCP creds view".

## Wire protocol — frames

Wire-format authority: **[`docs/MCP-PROTOCOL.md`](docs/MCP-PROTOCOL.md)**. Connector-side zod schemas in [connector/src/tunnel/frames.ts](connector/src/tunnel/frames.ts) match it. Frame categories:

- **Lifecycle**: `register` / `manifest-delta` / `rpc` / `heartbeat` / `goodbye`
- **Webhook ingress** (v1): `webhook-allocate` / `webhook-allocate-ack` / `webhook` / `webhook-revoke`
- **Creds** (v1): `creds-request` / `creds-response` / `creds-update` — `author` field is `"twilio"` for Type 3, `"customer"` otherwise
- **3rd-party roster** (v1.1): `mcp-config-snapshot` / `mcp-config-delta` / `mcp-config-ack` / `mcp-config-resync` — keyed by `mcpId`, connector-RAM-only, survives WS reconnect
- **Local rescan** (v1.2): `local-mcps-rescan` / `local-mcps-rescan-ack`
- **Server notifications** (v1.2): `mcp-notification` — forwards `notifications/*` verbatim
- **Approval gate** (v1.3): `mcp-discovered` / `mcp-enable` / `mcp-disable` / `mcp-enable-ack`

Backwards compat: an older controller that doesn't know `creds-request` triggers the 5s soft-wait timeout per MCP — the connector logs `warn` and falls back to `dir/.env`. WS stays open; not a fatal protocol error.

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`.

The dispatcher forwards beyond `tools/*`: `prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `completion/complete`, `logging/setLevel` all forward through `McpServerConnection`'s matching method. Routing: `prompts/get` mirrors `tools/call` (`${server}.${name}` qualifier); resource methods route by `params.serverName` with a fallback to URI scheme; aggregate `*/list` methods accept an optional `params.serverName` to narrow to one MCP; `completion/complete` and `logging/setLevel` REQUIRE `params.serverName`. `ServerDescriptor` carries optional `prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities` arrays — only populated when the upstream MCP advertised the matching capability.

`webhook` frames share the WS with `rpc` traffic and `heartbeat`s. Three rules keep that mix safe:
- **No per-frame await.** The TunnelClient's `send()` is synchronous; webhook delivery doesn't block heartbeat scheduling.
- **No chunking.** Webhook frames are single JSON lines; the controller caps body at 256 KB (413 over) — that's also the implicit ceiling on tunnel frame size.
- **Webhook latency vs RPC latency.** Twilio's payment / status callbacks are not latency-sensitive. The controller is the synchronous HTTP responder — it returns 200 to the upstream immediately and forwards async over the WS.

Each `ServerDescriptor` in the manifest carries an `author: string` field — derived by the connector from the spec, never configured. Today's values: `"twilio"` for any MCP resolved via the `bundled:` yaml form (Type 3), `"customer"` for everything else. The controller uses this to group MCPs in its UI. Type 2 (3rd-party) MCPs pushed by the controller arrive with `"customer"` and the controller does its own author-tagging server-side. Typed as `string` (not a union literal) so the controller forward-compats new author values without a wire-format break. Derivation in `authorOf(spec)` at [connector/src/config.ts](connector/src/config.ts), invoked once per server in [connector/src/manifest/build.ts](connector/src/manifest/build.ts).

Also on every dispatched `tools/call`: if the child MCP was closed under a live request (typical cause: supervisor restart triggered by `creds-update`), the dispatcher's catch block detects `!this.deps.servers.has(serverName)` and replies with `kind: "mcp_disconnected"` instead of the generic `tool_failed` — see [`connector/src/dispatcher.ts`](connector/src/dispatcher.ts). Lets the controller attribute the failure to a mid-flight restart rather than a genuine tool crash.

## Workspace shape

npm workspaces, **one package**: `@mcp-shim/connector`. That's the only thing that ships.

**Module system: native ESM.** [connector/package.json](connector/package.json) declares `"type": "module"`; tsc emits `dist/**/*.js` as ESM (paired with `module: NodeNext` in [tsconfig.base.json](tsconfig.base.json)). Source files use `import`/`export` exclusively; relative imports MUST carry the `.js` extension (NodeNext requirement). For CJS-only ergonomics: use `createRequire(import.meta.url)` from `node:module` and `fileURLToPath(import.meta.url)` from `node:url` for `__dirname`/`__filename` equivalents. **Don't add `require()` calls or `__dirname` references in new code** — they fail at runtime under ESM.

Type 1 MCPs are **not** workspaces, but every one may carry a minimal `package.json` so it can grow third-party SDKs in isolation:

- **Framework deps (`zod`, `@mcp-shim/connector/sdk`)** are not listed per-folder. They resolve via Node's parent-dir walk to the workspace root `node_modules`, where npm hoists them once.
- **Third-party SDKs (`twilio`, `axios`, etc.)** are declared in the MCP's own `package.json` `dependencies` block and install into that folder's `node_modules`. They never hoist to the workspace root, so other MCPs can't accidentally `import "twilio"`.

A folder's `package.json` may have an empty `dependencies` block (or none at all) when it imports only framework deps. `scripts/start-connector.sh` runs `npm install --omit=dev` in any MCP folder whose `package.json` has a non-empty `dependencies` block but is missing `node_modules` — first-boot is one-shot. The Dockerfile mirrors the same loop at image-build time. Bumping a dep *version* in `package.json` while `node_modules` already exists is a case the auto-install doesn't catch — run `npm install` in that folder yourself.

Customers consume the OCI image, never the npm package. `connector/package.json` stays `"private": true` permanently; `bin`, `exports`, and `files` fields are retained because they're used by the `mcp-connector` CLI running *inside* the container and by the SDK re-export path for drop-in MCPs.

### Key modules

- **`connector`** — the customer-side process. Config, MCP clients to local servers, WSS tunnel, dispatcher, supervisor (Type 1 child supervisor + drop-in spawner + Type 2/3 connector), inspector UI, CLI (`start` / `init` / `discover` / `register` / `version`).
- **`connector/src/sdk/`** — the surface customer-authored Type 1 servers import. `Tool` interface (incl. optional `envKeys?: string[]`) + `createMcpHttpServer({name, tools, port?, envKeys?, capabilities?})` factory. Re-exported from `@mcp-shim/connector/sdk`. The factory's HTTP server exposes `/envkeys` returning the de-duped union of every tool's `envKeys` (or the server-level list when `opts.envKeys` is set) — the supervisor queries it post-spawn so the connector can include it in `creds-request` frames. `capabilities?: Record<string, unknown>` is the seam for protocol extensions that need custom capability groups on the MCP `initialize` response (e.g. `bundled-mcps/agentic-memory` per [docs/AGENTIC-MEMORY-MOCK.md](docs/AGENTIC-MEMORY-MOCK.md)); custom shapes nest under the first-class `extensions` field (MCP `2026-07-28` — verified preserved through `getServerCapabilities()`) with a vendor namespace. (`experimental` still works for pre-2026 peers.) Drop-ins pick up an optional per-folder `capabilities.ts` (default-exported Record) via `loadCapabilities` in [`dropin-discovery.ts`](connector/src/sdk/dropin-discovery.ts).
- **`connector/src/sdk/dropin-runner.ts`** — synthesized child entrypoint for drop-in MCPs. Auto-discovers default-exported (or first-named-export-of-shape) `Tool` / `Prompt` / `Resource` objects from `${DROPIN_DIR}/{tools,prompts,resources}/*.{ts,js}` and calls `createMcpHttpServer(...)`. Discovery logic lives in [connector/src/sdk/dropin-discovery.ts](connector/src/sdk/dropin-discovery.ts) so it's unit-testable without spawning a real child process.
- **`connector/src/dropin.ts`** — `discoverDropins({ yamlNames })` scans `MCP_DROPIN_DIR`, returns synthesized Type 1 specs. Skips folders with a yaml entry or a hand-written `server.ts`.
- **`connector/src/mcp-supervisor.ts`** — owns the lifecycle of every MCP child (Type 1 hand-written, Type 1 drop-in, Type 2 stdio, Type 2 http, Type 3 bundled). Exposes `register(specs) / startAll() / restart(name, reason) / stopAll()`, applies controller-supplied env via `applyControllerEnv(mcp, env, source, reason)`, tracks per-MCP `McpStatus` (process / credsSource / credsLastUpdated / restartCount / lastRestartReason / toolsCount / **source** / **mcpId**), and mutates the SHARED `servers: Map<string, McpServerConnection>` so the dispatcher and inspector pick up new connections without re-wiring. **Before editing, read the invariant blocks in the source file** — spawn-mutation (`__port` gating in `stopEntry`), auth resolution ordering, `NODE_PATH` computed-once for drop-in spawns, sync-vs-async auth cache keying. `stopEntry`'s SIGTERM path logs a `warn` if the 2s SIGKILL fallback fires so operators can attribute a stuck restart.
- **`connector/src/tunnel/creds-coordinator.ts`** — fans out `creds-request` per MCP after register-ack, awaits the 5s soft-wait, applies responses via `supervisor.applyControllerEnv`. Late `creds-response` frames and `creds-update` push frames go through the same code path. Re-built per tunnel — the `pending: Map<requestId, …>` is pending IPC; a reply from a stale tunnel landing on a fresh one would be wrong.
- **`connector/src/servers/connect.ts`** — transport dispatch for outbound MCP connections. `stdio` specs go to `connectStdio`; `http` specs branch on the internal `__transportKind` marker: `"sse"` → `connectSse`, anything else → `connectHttp` (default). The wire-side `McpConfigEntry.transport` carries http / streamable-http / sse / stdio; the supervisor-side `McpServerSpec` stays two-valued (`http` / `stdio`) so the HTTP-family wire variants collapse to the `http` spec with the SUB-transport on `__transportKind`. Outbound clients set `versionNegotiation: { mode: "auto" }` — they speak `2026-07-28` when the upstream supports it and fall back to the 2025 handshake otherwise. **WebSocket was removed**: MCP SDK v2 dropped `WebSocketClientTransport` (WebSocket is not a spec transport), so a stale `websocket` entry from an older controller is rejected clearly in `connectServer` (non-fatal, continue-on-fail). Controller-side dropdown removal is in the MCP-SDK-V2-MIGRATION plan §8.
- **`connector/src/tunnel/mcp-config-coordinator.ts`** — in-memory roster of controller-pushed 3rd-party MCPs. Handles `mcp-config-snapshot` / `mcp-config-delta` / `mcp-config-resync` over the WS, translates `McpConfigEntry` → `SupervisedSpec`, reconciles via `supervisor.{hasEntry,registerOne,startOne,replaceSpec,unregister}`. Threads `mcpId` into `creds-request`. **Lifetime contract**: constructed once per process (in `boot()`), rebound per tunnel via `bind({send, log?})` — see the source file's LIFETIME block.
- **`connector/src/tunnel/local-mcps-coordinator.ts`** — controller-triggered `local-mcps-rescan` + inspector loopback `/mcp/rescan-local`. Re-runs `discoverDropins({yamlNames})` and reconciles against supervisor entries filtered to `source === "local"`. Same lifetime contract as `mcp-config-coordinator.ts`. Single-flight; `onMcpAdded` fans out a `creds-request` for rescan-added MCPs.
- **`connector/src/dispatcher.ts`** — routes controller `rpc` frames to the right local MCP. On tool failure, distinguishes `tool_failed` (genuine crash / rejection) from `mcp_disconnected` (server was closed while awaiting the reply) via a check against the shared `servers` map.
- **`examples/demos/sample`** / **`examples/demos/crm`** — Type 1 drop-in demos.
- **`examples/mock-backend`** — Postgres-backed customer store consumed by the crm drop-in. Deploys as its own private-only Fly app. HTTP boundary is load-bearing — swapping Postgres for a real CRM (Salesforce / Zendesk / etc.) is a mock-side change; the drop-in stays a `fetch` client.
- **`bundled-mcps/agentic-memory`** — Type 1 drop-in (Node). Mock memory + identity provider. Wire-inventory + custom-capabilities envelope deviation at [docs/AGENTIC-MEMORY-MOCK.md](docs/AGENTIC-MEMORY-MOCK.md).
- **`bundled-mcps/enterprise-knowledge`** — Type 3 config stub. Just a `.env.example`. Bundle *source* lives at [`bundled-mcps/enterprise-knowledge/source/`](bundled-mcps/enterprise-knowledge/source/); the source tree does *not* ship — `pip install` during image build populates `/opt/bundled-mcps/enterprise-knowledge/.venv/`.

Type 1 servers use the MCP SDK v2 `createMcpHandler` (from `@modelcontextprotocol/server`) adapted to Node via `toNodeHandler` (from `@modelcontextprotocol/node`). It is **stateless** — a fresh `McpServer` per request, no `Mcp-Session-Id` — and serves MCP `2026-07-28` **and** the 2025-era protocol from one endpoint (createMcpHandler's default `legacy: 'stateless'`). The factory in `sdk/http-server.ts` is the one place this is set up; it also hosts the connector-specific `/envkeys` route alongside `/mcp`. Bundled + drop-in + example MCPs all flow through this factory, so they all serve the new protocol.

## CLI subcommands

[connector/src/index.ts](connector/src/index.ts) dispatches on `argv[0]`:

| Subcommand | Module | Notes |
|---|---|---|
| `start` (default) | `index.ts` `main()` | spawns Type 1 children, dials the tunnel; flags: `--config`, `--inspector-port`, `--no-inspector` |
| `discover` | [connector/src/discover.ts](connector/src/discover.ts) | non-interactive `tools/list` per server, then exits |
| `doctor` | [connector/src/doctor.ts](connector/src/doctor.ts) | preflight checks against env + creds source. Exit 0 all-ok, 1 any fail, 2 any warn no fail — for `doctor && start` runbooks. Split into `runChecks(env, opts)` (pure) and `runDoctor(argv)` (CLI wrapper); tests inject env as a literal map |
| `deploy init` | [connector/src/deploy/scaffold.ts](connector/src/deploy/scaffold.ts) | renders cloud manifests for `--target {fargate\|gke\|aca\|compose\|fly\|fly-mock}` with `{{NAME}}` / `{{CONTROLLER_URL}}` substituted. Templates are plain strings in [`deploy/templates.ts`](connector/src/deploy/templates.ts) — no engine. `{{VAR}}` on purpose (not `${VAR}`), so runtime yaml `${VAR:-}` interpolation in the emitted GKE configmap survives untouched. `fly-mock` skips the controller-url prompt via `targetNeedsControllerUrl` |
| `deploy apply` | [connector/src/deploy/apply.ts](connector/src/deploy/apply.ts) | actually deploys using config from a prior `deploy init`. Today only `--target fly` is implemented — spawns Fly's CLI directly with idempotency guards. Non-Fly targets exit 2 with "not yet implemented" |
| `version` | inline | prints `CONNECTOR_VERSION` or `dev` |

Tunnel identity + creds come from the sealed `controllers` row and are configured via the inspector Configure Tunnel modal. A credential that's set but doesn't match any controller row boots fine here and gets rejected at the WS handshake with HTTP 401 — that's a controller-side decision, not something we can detect locally before dialing.

Logging is **Pino** ([connector/src/logger.ts](connector/src/logger.ts)) — pretty-printed in dev TTY, raw JSON in non-TTY (CI / `> log.txt` / Docker). Set `LOG_LEVEL=debug` to raise verbosity. Every component (`connector`, `dispatcher`, `inspector`, each Type 1 MCP, `mock-customers`) gets a child logger via `createLogger('component')`. Type 1 MCP authors get the same logger via `import { createLogger } from "@mcp-shim/connector/sdk"`. Don't reintroduce `console.log` for runtime telemetry — CLI commands (`discover`, `doctor`, `deploy init`, `--help` / `--version`) are the only place direct stdout writes belong.

## Common commands

```bash
# Connector workspace. Pulls in tsx (used by the spawner to run Type 1 children).
npm install
npm run build

# In dev, point POSTGRES_URL at your local Postgres (or `docker compose -f
# deploy/compose/docker-compose.prod.yml up postgres` for a sibling one)
# and mint a master key.
export POSTGRES_URL="postgres://mcp:$(cat pg_password)@localhost:5432/mcp_connector"
head -c 32 /dev/urandom > /tmp/connector.key && chmod 400 /tmp/connector.key
export CONNECTOR_KEY_FILE=/tmp/connector.key

./scripts/start-connector.sh
```

**Multi-instance dev workflow.** Pass an optional port arg (`./scripts/start-connector.sh 9091`) to spin up additional connectors on the same host, each with its own tunnel identity. Each port gets its own `POSTGRES_SCHEMA` (`mcp_connector` for 9090 to preserve historical state; `mcp_connector_<port>` otherwise) and its own `MCP_BASE_PORT`. Instances coexist via per-port PID files at `.local/pid-<port>` — same-port second run kills the first; different ports run in parallel. Env-var derivations documented in [docs/ENV-VARS.md](docs/ENV-VARS.md).

First boot lands on an empty `controllers` row — the inspector renders "Configure Tunnel". Fill in the modal (controller URL, name, auth posture); the connector seals + persists identity + creds to the row, then reconnects.

Inspector UI: <http://localhost:9090/>. There's only one inspector per connector process.

A Type 1 / Type 3 entry whose child crashes on boot fails at the spawner readiness probe / `connectServer` call. `startAll` **logs the failure and CONTINUES** to the next entry — a broken MCP does not take down the connector or its siblings. The failed entry surfaces as `permanently-failed` in the inspector's MCP Status panel; recovery is either the inspector's per-MCP "Reload creds" / "Restart" buttons or a fix to the entry's `dir/.env` + connector restart. The `fail_mode` field in yaml `policy:` is spec-only today — effective behavior is continue-on-fail.

Primary verification is **interactive via the inspector UI**:
- **MCP Server** panel — local MCP servers and their tools.
- **Available Tools** panel — each discovered tool with a "Ready" verdict.
- **Webhooks** panel — each MCP's allocated public URL with a copy button (only populated for MCPs that called `createWebhookEndpoint`).
- **MCP Status** panel — per-MCP `McpStatus` (process state, creds source, restart count + last reason, tools count) with state-colored borders. Clicking an MCP's name opens its message history (every request/response/notification tapped from the shared `servers` connection via [`connector/src/servers/message-tap.ts`](connector/src/servers/message-tap.ts)) in the right pane; each entry collapses to a one-line summary (timestamp / direction / method) by default and expands to the full JSON payload on click (no nested scroll — the pane itself scrolls). History persists across selections until **Restart** or **Clear** is clicked, both of which call `Inspector.clearMcpMessages` — **Restart** as a side effect of respawning, **Clear** (`POST /mcp/messages/clear`) standalone, without touching the child. Per-MCP actions: **Reload creds** (forces a `creds-request` and restarts on response), **Restart** (resets consecutive-failure counter and re-spawns with current env), and **Clear**. Session-creds view exposes **Apply (session only)** and **Clear session creds** for early revocation before the 12h TTL.
- **Frames** panel — live WS state + every frame in/out (filterable; heartbeats hidden by default). Includes webhook frames and creds frames.
- **Reconnect** button — re-reads the YAML (`policy` changes), then redials. To pick up changes to `mcp_servers`, restart the script — those connections happen at boot.

There is also a **vitest** suite for defensive regression tests — regression-driven, tests added when manual scenarios surface real bugs, not for coverage.

```bash
cd connector
npm test          # one-shot run; uses --root ../.. so it sees the root vitest.config.ts
npm run test:watch # watch mode for the active test file
```

Tests live at `connector/tests/**/*.test.ts` mirroring `src/` (peer-tests layout, not colocated — `tsconfig.json`'s `rootDir: "src"` would otherwise compile tests into `dist/` and ship them in the OCI image). Use explicit `import { describe, it, expect } from "vitest"` — globals are off. Shared fixtures land in `tests/helpers/` once the second test needs the same factory.

## Reference material (`examples/`)

`examples/demos/sample/` and `examples/demos/crm/` are Type 1 drop-in demos. Neither is auto-loaded from `examples/` — the connector's Dockerfile COPYs them into `bundled-mcps/` at image-build time (non-gated bundle path); local dev either symlinks or copies into `bundled-mcps/`.

`examples/mock-backend/` deploys as its own private-only Fly app via `mcp-connector deploy init --target fly-mock`.

## Inspector UI notes

The inspector lives inside the connector process at `INSPECTOR_PORT` (default 9090) and **binds to `127.0.0.1` only** (enforced in [connector/src/inspector/server.ts](connector/src/inspector/server.ts)'s `server.listen(port, "127.0.0.1", …)`). It is part of the customer side; it does **not** proxy or impersonate the controller. Reach it from outside the container via port-forward / exec — never via an LB. Don't relax the bind to `0.0.0.0`: the Webhooks panel exposes the bcrypt-protected URL by design.

**Two auth layers guard the inspector routes despite the loopback bind:**

1. **CSRF guard on every state-changing POST.** `guardCsrf(req, res)` requires `Content-Type: application/json` AND a custom `X-Inspector-Request: 1` header — either alone would still be a "simple request" per CORS, which any browser tab the operator has open could fire cross-origin. Content-Type validation alone forces preflight, and the custom header adds belt-and-braces. Pinned by [`connector/tests/inspector/csrf-guard.test.ts`](connector/tests/inspector/csrf-guard.test.ts).

2. **Per-MCP webhook token on `/internal/webhook/stream` + `/revoke`.** The supervisor mints `randomBytes(32).toString("base64url")` per MCP at `register()` and injects it as `MCP_WEBHOOK_TOKEN` in the child's env. The SDK's `createWebhookEndpoint` sends it as `Authorization: Bearer <token>`. Inspector's `authorizeWebhookMcp` constant-time-compares against `supervisor.resolveMcpByWebhookToken(token)` and requires the caller's token to identify them as owner of the requested `mcp`. Prevents same-container sibling drop-ins from eavesdropping on each other's webhook events. Pinned by [`connector/tests/inspector/webhook-stream-auth.test.ts`](connector/tests/inspector/webhook-stream-auth.test.ts).

Both layers are load-bearing — the loopback bind alone would let (a) any browser tab silently exercise POST routes, (b) any local drop-in subscribe to any other drop-in's webhooks. Also emitted on every static-asset response: `Content-Security-Policy` (strict, no `unsafe-eval`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

The left column is draggable; the width is persisted in `localStorage` under `inspector.leftColPx`.

## Config files

Runtime config is intentionally minimal. The connector's env-var surface is documented at [docs/ENV-VARS.md](docs/ENV-VARS.md).

**Tunnel credentials live in Postgres.** Tunnel identity + creds live in a `controllers` row sealed at rest with libsodium `crypto_secretbox_easy`. The 32-byte master key comes from `CONNECTOR_KEY_FILE` (typically a K8s Secret / Docker Compose secret / Fly secret / cloud key-vault mount). Operators manage the row via the inspector's Tunnel panel — no shell access, no process restart on rotation. **Empty DB at boot is a valid state**: the inspector renders "Configure tunnel", MCPs still spawn, no `TunnelClient` is constructed until an operator submits the form. Routes live in [`src/inspector/tunnel-routes.ts`](connector/src/inspector/tunnel-routes.ts).

**TDZ discipline inside `bootFromDb`.** Empty-DB boot returns from `bootFromDb` early, but the inspector's tunnel routes wire `dialTunnel` BEFORE that return — an operator submitting the Configure Tunnel modal invokes the closure while the function is still in its resting state. Any binding the closure (or `connectTunnelDb`) references MUST be declared ABOVE the `if (!row) return` early exit, else JavaScript's Temporal Dead Zone throws `Cannot access 'X' before initialization`. Pinned by [`tests/boot/lifecycle-tdz.test.ts`](connector/tests/boot/lifecycle-tdz.test.ts), a source-level static analyzer that fails CI if a captured identifier moves back below the empty-DB return. To add a new binding for the paste flow: hoist it with `| undefined` at the top of `bootFromDb` and guard on read.

| Runtime file | Purpose |
|--------------|---------|
| `${MCP_BUNDLED_DIR}/<name>/tools/` | Twilio-shipped Type 1 drop-ins. Default `/app/bundled-mcps` in the image; dev overrides via `scripts/start-connector.sh`. Always on. |
| `${MCP_DROPIN_DIR}/<name>/tools/` | Customer-authored Type 1 drop-ins. Default `/var/lib/mcp-connector/customer-mcps/`. Approval-gated. |
| Postgres `mcp_connector` schema | `controllers` (one row) + `encryption_meta` (SHA-256 fingerprint of the master key). Created idempotently at boot. |
| `$CONNECTOR_KEY_FILE` | 32-byte libsodium master key. Read once at boot; entrypoint script writes it from `$CONNECTOR_KEY_B64` on env-only secret platforms (Fly, ACA). |
| `<any-mcp-folder>/.env` | Per-MCP dev escape hatch — loaded into that child's process only via `loadDropinEnv` (drop-ins) or `loadConfig`'s per-spec env map (yaml entries). Never leaks across MCPs. Never shipped as a tracked template. |

The controller dispatches `/crelay` and `/mcp-tunnel` on a single port (default 3001), so one DNS entry / one ngrok tunnel covers both. `CONTROLLER_URL` is the HTTPS root; the connector internally upgrades `https://` → `wss://` and appends the `/mcp-tunnel` path in [connector/src/tunnel/client.ts](connector/src/tunnel/client.ts) before opening the socket.

**Optional yaml.** [`connector/src/config.ts`](connector/src/config.ts)'s `loadConfig` still parses a `connector.yaml` if one exists — it's the dev knob for Type 3 `bundled:` entries and hand-written Type 1 shape. Production customers using the derived-image or volume-mount delivery paths don't author yaml anymore. When present, YAML `${VAR}` and `${VAR:-default}` interpolation apply; unknown vars without a default throw with the variable name and YAML line. Full-line yaml comments are treated as INERT by the interpolator so doc comments referencing `${CONTROLLER_URL}` don't hard-fail boot.

### Per-entry env precedence (subtle)

The highest-risk piece — read carefully before changing it. Four layers, lowest to highest precedence:

1. `dotenv/config` loads `./.env` (from CWD) once at startup → populates `process.env`.
2. `loadConfig` parses the yaml. Top-level `${VAR}` interpolation reads from `process.env` only. For each `mcp_servers[]` entry with `dir:`, the loader reads `<dir>/.env` into a **per-spec env map** (does **not** mutate `process.env`).
3. Inline `env:` map on the yaml entry (rare today; layered above `dir/.env`).
4. **Controller-supplied env from `creds-response` / `creds-update` frames.** The supervisor stores these in a per-MCP `controllerEnv` map and they win on conflict. See `mergeEnv` in [connector/src/mcp-supervisor.ts](connector/src/mcp-supervisor.ts) — merge order is `process.env ⊕ spec.env (yaml inline + dir/.env) ⊕ controllerEnv`.

Cross-entry leakage is impossible — child A's `API_TOKEN` (whether from `dir/.env` or controller-supplied) does not reach child B even if both declare the same key.

**Stdio entries go through the same merge.** The supervisor pre-builds merged env in `startEntry` and threads it through `connectServer(spec, env)` → `connectStdio(spec, env)` → `new StdioClientTransport({command, args, env})`. Same code path also decides restart-on-creds-rotation via `entry.child || entry.connection` — stdio entries leave `entry.child` undefined (the SDK owns the spawn), so the OR-clause is what catches them.

Per-spawn env-source telemetry: every spawn logs `mcp spawn env-sources` with `controller: [...]` and `dirDotEnv: [...]` — watch `dirDotEnv` trend toward `[]` as customers move creds into the controller (deprecation tracker).

Don't replace the per-spec env map with calls to `dotenv.config({path: ...})` in `loadConfig` — that mutates `process.env` and breaks the isolation guarantee. Don't widen the merge order without thinking through the cross-product with `applyControllerEnv` (which restarts the child with the new merged env).

### Env reading rule — empty string == not set

All `process.env` reads in `src/` go through [`src/env.ts`](connector/src/env.ts) (`envString` / `envOptional` / `envNumber`). The whole-module rule: **an empty-string env var is treated as "not set"** — fall back to the documented default. An admin who writes `FOO=` (blank line) in `.env` expects "leave this unset"; `??` previously let `""` flow through (`Number("")=0`, `resolve("")=cwd`, pino throws on empty level). `envNumber` additionally throws an admin-actionable error when set to a non-numeric value. The single deliberate exception is the YAML `${VAR}` interpolator in [`config.ts`](connector/src/config.ts), which substitutes the literal empty string.

Boot-time required-env preflight runs once in [`src/boot/require-env.ts`](connector/src/boot/require-env.ts) (`requireEnv()`) before yaml load or config-store open. It requires `POSTGRES_URL` + `CONNECTOR_KEY_FILE` — the only env vars needed at boot. Everything else (tunnel identity, auth posture, controller URL) lives in the sealed `controllers` row and is set via the inspector Configure Tunnel modal.

## Reconnect semantics

- WS close does **not** kill the connector process. It transitions the inspector to `closed` state and stops timers.
- Auto-reconnect is **on by default** (`policy.reconnect.enabled: true`). On unexpected close the connector schedules a redial via `scheduleAutoReconnect()` in `index.ts` and the inspector enters a `reconnecting` state showing "reconnecting in N.Ns · attempt K". A successful register-ack resets the attempt counter. SIGTERM/SIGINT and a manual click on the inspector's Reconnect button both cancel any pending auto-reconnect timer so a manual click fires immediately.
- Auto-reconnect is **suppressed when the controller rejects the register frame** (e.g. `unknown_registration_token`). The connector sets a `registrationRejected` flag in the `register-ack` handler; the next `onclose` logs `auto-reconnect suppressed` and stays in `closed`. Recovery is via the inspector Reconnect button — the manual path clears the flag.
- Backoff is computed by `nextReconnectDelay(attempt, policy)` at the bottom of `index.ts`. Today it returns a fixed delay (= `initial_backoff_ms`); swapping in a real backoff curve is a localized change.
- Set `policy.reconnect.enabled: false` to opt out — useful in deployed containers where the orchestrator (Fargate / Container Apps / GKE) is the supervisor and you want the inspector to surface a hard `closed` state.
- Reconnect re-reads the YAML. `sameMcpServers()` in `index.ts` compares name + transport + endpoint + command + dir + env across the prior and new lists. If anything in `mcp_servers` changed, the connector logs a warning and uses the prior list (live MCP server reconnect is out of scope). `policy` changes take effect.

## Process lifecycle gotcha

`scripts/start-connector.sh` boots one connector process; the connector itself spawns Type 1 children. The script's pre-cleanup uses `pgrep -f 'scripts/start-connector\.sh'` and skips its own PID — do NOT replace this with `pkill -f` patterns that match `node dist/index.js`, because that catches unrelated node processes and does not catch orphan wrapper shells. The pgrep pattern must match the script's filename — if you rename the file, update the pattern in the same change.

The connector's SIGTERM handler calls `supervisor.stopAll()`, which sends SIGTERM to every Type 1 / drop-in / Type 2 stdio / Type 3 child it spawned (with a SIGKILL fallback after 2s + a warn log if the fallback fires). Combined with the script's `trap cleanup EXIT INT TERM` (which `kill 0`s the process group), Ctrl-C cleans up the whole tree.

## Distribution

Primary shape is a signed multi-arch OCI image. Build:

```bash
./scripts/build-image.sh                                # local single-arch
IMAGE=registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh  # multi-arch + push
```

[connector/Dockerfile](connector/Dockerfile) is multi-stage; runtime image carries the connector's `dist/` + `public/` + production `node_modules` (incl. `tsx`) + bundled MCPs + Python venvs for Type 3 bundles under `/opt/bundled-mcps/<name>/`.

**Runtime UID: non-root `mcp:mcp`.** The entrypoint runs as root long enough to `chown` the master-key file, then drops via `su-exec mcp:mcp`. `CONNECTOR_KEY_B64` is `unset` before the exec so it doesn't leak into `/proc/1/environ`. If a customer mounts `/var/lib/mcp-connector/customer-mcps/` from the host, the mount must be readable by UID `mcp`. Base images are pinned to `@sha256:...` digests — a Dockerfile FROM line without a digest is a security-hardening regression; pinned by [`connector/tests/security/hardening.test.ts`](connector/tests/security/hardening.test.ts).

Customers extend the image via one of two first-class delivery paths, both landing at `MCP_DROPIN_DIR` (`/var/lib/mcp-connector/customer-mcps/`) and the same discovery code in [`src/dropin.ts`](connector/src/dropin.ts):

- **Derived image** — `FROM twilio/mcp-connector:1.0` + `COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/`, build their own image. Enterprise-friendly. Walkthrough: [deploy/DERIVED-IMAGE.md](deploy/DERIVED-IMAGE.md).
- **Volume mount** — bind-mount a host / K8s PVC / Fly volume / EFS at the same path. Faster dev loop, unlocks the "Refresh local MCPs" hot-rescan feature. Walkthrough: [deploy/VOLUME-MOUNT.md](deploy/VOLUME-MOUNT.md).

There is no "customer imports the npm package into their own Node service" path — the connector is a daemon, not a library.

[scripts/build-image.sh](scripts/build-image.sh) defaults to `linux/amd64,linux/arm64` (Graviton + ARM Macs). Per-cloud guides at [deploy/](deploy/) (AWS Fargate, Azure Container Apps, GCP GKE, Fly.io) document the foot-guns — most importantly, **don't put a load balancer in front of the connector** (nothing inbound) and **don't use Cloud Run / App Service / Fly `auto_stop_machines` / scale-to-zero anything** (kills the WSS).

The runtime `ENTRYPOINT` is a shell script at [`connector/entrypoint.sh`](connector/entrypoint.sh). If `$CONNECTOR_KEY_B64` is set (Fly.io, ACA, or any secret-store-as-env platform), it base64-decodes into `$CONNECTOR_KEY_FILE` (default `/etc/mcp-connector/connector.key`) with mode 0400, then execs `node dist/index.js "$@"`. If `$CONNECTOR_KEY_B64` is unset (docker-compose, K8s Secret volume, hand-provisioned VM), it's a strict no-op. Pinned by [`connector/tests/deploy/entrypoint.test.ts`](connector/tests/deploy/entrypoint.test.ts). Don't add validation logic in the entrypoint — that's the connector's env-loading path's job.

## Deployment scaffolding

Three complementary shapes ship alongside the OCI image:

- **`deploy/compose/docker-compose.prod.yml`** — single-VM shape, `docker compose up -d` to a running connector. Ships with a sibling Postgres. **The `127.0.0.1:9090:9090` port binding is load-bearing** — binding the inspector to `0.0.0.0` leaks the bcrypt-protected webhook URL. Pinned by [`connector/tests/compose/compose-lint.test.ts`](connector/tests/compose/compose-lint.test.ts).
- **`mcp-connector deploy init --target {fargate|gke|aca|compose|fly|fly-mock}`** — CLI verb that renders the target's manifests. Templates in [`src/deploy/templates.ts`](connector/src/deploy/templates.ts). The `fly` target's fly.toml deliberately has NO `[[services]]` / `[http_service]` / `auto_stop_machines` — pinned by [`connector/tests/deploy/scaffold.test.ts`](connector/tests/deploy/scaffold.test.ts) via line-start regex.
- **Reference bundles** — [`deploy/fly/`](deploy/fly/README.md) ships `fly.toml.example` + a full operator runbook.
- **IaC modules** — [`deploy/terraform/aws-fargate/`](deploy/terraform/aws-fargate/README.md) and [`deploy/helm/mcp-connector/`](deploy/helm/mcp-connector/README.md). Both hardcode `replicas: 1` / `desired_count: 1` — dup-name guard, don't template that.

`mcp-connector deploy apply --target fly` pairs with `deploy init`. Under the hood, `apply` spawns Fly's CLI directly — five commands with idempotency guards (see [`src/deploy/apply.ts`](connector/src/deploy/apply.ts)). `spawn` is DI'd for test injection (native ESM blocks `vi.spyOn` on `child_process.spawnSync`). Other targets return "not yet implemented" from `apply`; operators use the cloud's native tool (`aws` / `kubectl` / `az` / `docker compose`) per the init README appendix.

**Push-to-deploy via GitHub Actions (Twilio-demo Fly.io deploy only).** Two workflows under [`.github/workflows/`](.github/workflows/): `pr-checks.yml` runs `npm run build` (typecheck via `tsc -b`) + `npm test` on every PR against `main`; `deploy-main.yml` runs `./scripts/deploy/fly-deploy.sh --redeploy-only --skip-build` on every push to `main` (PR merge or direct push). `--redeploy-only` skips the 4-step Fly bootstrap (apps/postgres/secrets/volumes create) — those need org-level auth the app-scoped `FLY_API_TOKEN` lacks; bootstrap is a one-time local step. See [`scripts/deploy/fly-deploy.sh`](scripts/deploy/fly-deploy.sh) header for both flag semantics. Deploy workflow reuses the SAME shell script operators run locally — drift between local and CI flows is structurally impossible. Three org-policy load-bearers baked into every workflow file — **verify all three when adding a new workflow**: (1) `runs-on: depot-ubuntu-24.04` — internal repos have NO GitHub-hosted runners; `ubuntu-latest` queues forever with no error; (2) `sha_pinning_required: true` — every action ref must be a full 40-char commit SHA; (3) `allowed_actions: selected` — `superfly/flyctl-actions` and `pnpm/action-setup` are NOT whitelisted, so flyctl is curl-installed and npm (not pnpm) is used. `FLY_API_TOKEN` is a repo secret scoped to `twilio-tool-sdk`. CD is not gated on PR checks; direct pushes to `main` deploy immediately. Doc-only pushes (`**/*.md`, `.claude/**`, `architectural-plans/**`, `docs/**`) are skipped via `paths-ignore`. **Customer connectors deploy release-driven via `mcp-connector deploy apply`** — this workflow is Twilio-demo Fly only. Do NOT extend this pattern to a second target (customer clouds get versioned OCI images + IaC modules, not push workflows).

`mcp-connector doctor` complements all three: run before boot to catch missing env / bad key file / unreachable Postgres.

## OpenAI / LLM

There is no LLM client in this repo. If a future change brings one in, that's a strong signal something's drifting away from the productized design.

Historical note for any future LLM integration in *adjacent* code: `gpt-5.x` chat completions require `max_completion_tokens` (not `max_tokens`) and reject any `temperature` other than the default.

## graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than raw grep output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
