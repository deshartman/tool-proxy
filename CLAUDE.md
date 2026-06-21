# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A customer-side **MCP connector**: a process that runs behind a customer's firewall, dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests. Per the productized design in `MCP-TUNNEL.md` (held outside this repo).

**Not** a generic MCP framework. **Not** an agent. **No LLM lives here.** The connector is a tool dispatcher with policy.

## Topology — one connector, many MCPs

The repo ships **one connector binary** (`packages/connector`) and **MCPs** under `mcp/` — split into `mcp/local/` (customer-authored, Type 1), `mcp/external/` (Type 2 config-only stubs), and `mcp/bundled/` (Twilio-authored, pre-installed in the connector image — can be **Type 1 or Type 3**). The folder marks *who ships it*; the YAML entry shape determines *how it's wired*. Today `mcp/bundled/twilio/` is a Type 1 (Node `server.ts` + per-folder `package.json` for the `twilio` SDK) and `mcp/bundled/enterprise-knowledge/` is a Type 3 (Python venv stub). Type 3 *source* lives at `bundles/<name>/` — deliberately outside `mcp/` so the runtime image only carries the installed venv (`/opt/bundled-mcps/<name>/.venv/`), not the build inputs (`pyproject.toml`, `src/`, `migrations/`). A single connector process reads one `packages/connector/connector.yaml` listing all MCPs and either spawns them as Type 1 children (auto-port), dials them as Type 2 endpoints, or launches Type 3 bundle entrypoints. In production this is one container per `connector_id`; in dev it's one local process.

Sample tools: `now`, `slow_echo`, `uuid`, `weather`. Orders: `get_recent`, `issue_refund`. Aviation-weather (Type 2 stdio): `wx_metar`, `wx_taf`, `wx_pireps`, `wx_sigmets`, `wx_icon_d2`, `wx_outlook`, `wx_preflight`, `wx_route`. Twilio (Type 1 under `mcp/bundled/twilio/`, yaml entry name `apis`): messaging — `messages_create`, `messages_fetch`, `messaging_services_fetch`, `content_templates_fetch`; voice — `calls_create`, `calls_fetch`, `voice_say`, `voice_play`, `voice_dial`, `voice_pay`, `voice_transcription_start`, `voice_transcription_stop`; verify — `verify_send`, `verify_check`, `verify_services_fetch`; lookups — `lookups_fetch`; email — `email_send`, `email_fetch`, `email_search`, `email_templates_fetch`. Enterprise Knowledge (Type 3 bundled stub): `sources_register`, `sources_fetch`, `sources_refresh`, `knowledge_query`.

The Twilio MCP previously lived in a sibling project `../twilio-mcp-shim/` that modeled the production deployment shape (Twilio runs its own connector, customer runs theirs). It has been re-folded into this repo at [`mcp/bundled/twilio/`](mcp/bundled/twilio/) so a single `./scripts/start-connector.sh` boots one connector that exposes both customer-side MCPs (`sample`, `crm`) and Twilio's own (`twilio`). It lives under `mcp/bundled/` because Twilio ships it in the connector image; it's wired as Type 1 because it's Node — there's no Python or venv involved. The sibling project is preserved as a reference for the original two-connector deployment shape but is no longer the source of truth.

The controller is **outside this repo** — this repo only ships the customer side.

### Three MCP integration patterns

- **Type 1 (customer-authored).** Folder under `mcp/local/<name>/` with `tools/*.ts` + `server.ts` (5 lines: import the SDK factory, list tools, call `createMcpHttpServer`). The yaml entry sets `transport: http` + `dir:` and **omits `endpoint`** — that's how the connector knows to spawn it. The supervisor runs `tsx <dir>/server.ts` with `PORT=<auto-assigned>` (probe-bind from `MCP_BASE_PORT`, default 7100), waits for the TCP listener, then sets the spec's `endpoint` to `http://127.0.0.1:<port>/mcp` so the existing connect path works unchanged. No build step per MCP.
  - **Type 1 drop-in (no `server.ts`).** Folders under `${MCP_DROPIN_DIR}/<name>/tools/*.ts` with NO `server.ts` are auto-discovered at boot by [packages/connector/src/dropin.ts](packages/connector/src/dropin.ts) and spawned via the shared synthesized entrypoint at [packages/connector/src/sdk/dropin-runner.ts](packages/connector/src/sdk/dropin-runner.ts). The runner reads `DROPIN_DIR` / `DROPIN_NAME` from its env, scans `tools/*.{ts,js}`, picks each module's default export (fallback: first named export with a Tool shape), and calls `createMcpHttpServer({name, tools})`. The yaml does NOT need an entry; the scanner skips folders that already have a yaml entry (yaml wins) or a hand-written `server.ts` (author intent). `MCP_DROPIN_DIR` defaults to `/var/lib/mcp-connector/customer-mcps/` in production; `scripts/start-connector.sh` exports `MCP_DROPIN_DIR=$ROOT/mcp/local` for dev so today's `mcp/local/sample` and `mcp/local/crm` keep working as Type 1 entries (they have `server.ts`, so the scanner skips them). Migration story: customer deletes their `server.ts`, restarts the connector, the runner synthesizes one in-process. See [.claude/plans/MCP-LOADING.md](.claude/plans/MCP-LOADING.md).
- **Type 2 (connect to existing MCP).** Pure config — yaml entry sets `transport: http` + `endpoint`, or `transport: stdio` + `command`. Optional `dir` (under `mcp/external/<name>/`) whose `.env` is loaded into the child's environment (handy for stdio servers that need API keys; ignored for Type 2 http unless future features wire it in). No customer-authored code needed.
- **Type 3 (bundled, Twilio-authored Python venv, pre-installed in this image).** Yaml entry sets `bundled: <name>` plus an optional `dir:` (under `mcp/bundled/<name>/`) for a per-bundle `.env`. The connector resolves `bundled:` against `BUNDLED_MCPS` in [packages/connector/src/config.ts](packages/connector/src/config.ts) — a registry of bundles laid down at image-build time under `/opt/bundled-mcps/<name>/`. Resolution synthesizes a stdio spec, so the rest of the supervisor code is unchanged. Bundle source lives in **`bundles/<name>/`** at the repo root (separate from `mcp/` so the runtime image carries only the installed venv, not the build inputs); the connector's Dockerfile reads it during the bundle-build stage and `pip install`s it into the venv. Customer surface area: one yaml line + one `.env` file. No code, no `pip install` from the customer's side. Local-dev override: `BUNDLE_DEV_OVERRIDE_<UPPER_NAME>=/abs/path/to/launcher` redirects launch to a working tree (`scripts/start-connector.sh` auto-exports this for any bundle that ships a `dev-launch.sh`).

Note: a Twilio-authored MCP doesn't have to be Type 3. A Node MCP that needs a third-party SDK (e.g. `mcp/bundled/twilio/` shipping the `twilio` package) lives under `mcp/bundled/` *because Twilio ships it*, but is wired as Type 1 (yaml entry has `transport: http` + `dir:` and no `endpoint:`). Type 3 is specifically the Python+venv shape — use it when the bundle has its own non-Node deps that can't (or shouldn't) be hoisted into the connector workspace.

The detection helpers in [packages/connector/src/config.ts](packages/connector/src/config.ts) are `isType1Spawn(spec)` (http + dir + no endpoint) and `isType3Bundled(spec)` (stdio + bundled set). Type 3 resolution happens in `loadConfig` *before* the discriminated union parses, because `bundled:` entries have no `transport` field. Don't widen the classifiers without thinking through the cross-product with `sameMcpServers`'s reconnect-comparison logic — `bundled` is part of that equality check so an edit from `bundled: a` to `bundled: b` is detected even when both happen to resolve to identical commands.

### Adding a new MCP

Edit `packages/connector/connector.yaml` and add one entry. There is no per-folder `connector.yaml` any more. For Type 1, drop tools + `server.ts` under `mcp/local/<name>/`. For Type 2, just point at the endpoint or command; create a folder under `mcp/external/<name>/` only if the entry has its own `.env`. For Type 3, set `bundled: <name>` against a bundle that's already registered in `BUNDLED_MCPS`; supply only a `.env` in `mcp/bundled/<name>/`.

## Architecturally load-bearing properties

- **Outbound-only.** The connector opens **no inbound ports** for the tunnel. It dials out; the controller pushes RPC requests back down the same WS the connector opened.
- **Trust boundary is per MCP server, not per tool.** Every tool a server in `mcp_servers[]` exposes is forwarded to the controller. The customer controls *which* MCP servers run on their machine; that's the gate. We deliberately diverged from MCP-TUNNEL.md §"Configuration surface" (which prescribes a default-deny `allow_list.tools` block) — per-tool gating duplicated authority and forced a YAML edit on every new tool. Don't reintroduce `allow_list` without an explicit ask. The wire format keeps `ToolDescriptor.allowed` (controller may still display it; future enterprise-strict mode might use it) — the connector always sets it to `true`.
- **Schema declaration follows the trust boundary.** Tools we author (Type 1 customer-side, Type 3 Twilio bundles) declare `outputSchema` so controller-side procedure authors can write `{{ hydrate:<server>.<tool>.<field> }}` and have it type-checked. Tools we don't author (Type 2 externals) pass through verbatim — the controller handles missing schemas gracefully on its end. The boot-time check at [`packages/connector/src/manifest/validate.ts`](packages/connector/src/manifest/validate.ts) logs `error` per offending Type 1 / Type 3 tool but does NOT throw — a missing schema is a per-tool bug, not a connector-wide failure (the rest of the manifest still works). Paired with per-tool tests at [`packages/connector/tests/mcp-tools/`](packages/connector/tests/mcp-tools/) that pin both the schema declaration AND the success-path `structuredContent` round-trip; CI is the primary line of defense, the boot log is the runtime backstop. See [.claude/plans/OUTPUT-SCHEMA.md](.claude/plans/OUTPUT-SCHEMA.md) and [`packages/connector/README.md`](packages/connector/README.md) "Author a Type 1 MCP" for the five authoring rules.
- **WS-handshake auth is per-tunnel, controller-minted.** The connector sends two headers on the `/mcp-tunnel` upgrade: `Authorization: Bearer <bearer>` and `X-Connector-Name: <CONNECTOR_NAME>` (the lookup key — must match the row's Name field exactly, case-sensitive). The controller looks up the `tunnel_security_configs` row by `(tenant_id, name)` and verifies the bearer; mismatch = HTTP 401. The legacy single-shared `TUNNEL_AUTH_TOKEN` env var on the controller is gone — every connector needs its own row, minted by an operator in **Tools → Connectors → Tunnel Security**. Two postures, picked per row:
  - **Long-lived `ts_<rowId>_<random>`** — operator pastes Twilio AccountSid + AuthToken (or AccountSid + ApiKey), the controller verifies against Twilio's API at create time, then mints + bcrypt-stores the secret. Customer pastes the plaintext (shown once) into `TUNNEL_AUTH_TOKEN`. Rotate via the row's **Rotate Secret** button — the previous hash stays valid 24h via `secret_rotation_grace_until`. Connector code path: header build at [packages/connector/src/tunnel/client.ts:65-69](packages/connector/src/tunnel/client.ts#L65-L69) takes the static `authToken` branch.
  - **OAuth2 `client_credentials`** — same row-creation flow, but the controller hands back `client_id` + `client_secret` instead. Customer pastes them into `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` and sets `OAUTH_TOKEN_URL`. The connector POSTs `grant_type=client_credentials` to `OAUTH_TOKEN_URL` to mint a 1h JWT, caches it (refreshes <60s before expiry), presents it as the WS-upgrade bearer. Code path: [packages/connector/src/auth/oauth-provider.ts](packages/connector/src/auth/oauth-provider.ts) is constructed once in `main()` when `OAUTH_CLIENT_ID` is set, passed into every `new TunnelClient(...)` so the cached JWT survives auto-reconnect cycles. The header build at [packages/connector/src/tunnel/client.ts:65-69](packages/connector/src/tunnel/client.ts#L65-L69) takes the `authProvider` branch.

  Posture dispatch is purely env-driven: `OAUTH_CLIENT_ID` set → OAuth2; otherwise the static-bearer path. They're mutually exclusive — boot fails if neither is configured. Twilio-takeover story for OAuth2 deployments is `OAUTH_TOKEN_URL` flip from controller to `https://oauth.twilio.com/v2/token` with no connector code change; the static-bearer posture has no equivalent migration path.
- **Identity established at WS register-frame time.** Separate from the handshake: once the WS is up, the connector sends a `register` frame and the controller binds the session to a `connectors` row. On first connect the row is minted using `${CONNECTOR_NAME}` and the controller returns a `registrationToken` in the register-ack. The connector persists that token to `packages/connector/.connector-state.json` and presents it on every subsequent register frame. Strict mode: an unknown token is rejected (`unknown_registration_token`); the customer must clear the state file to mint fresh. The yaml uses `${CONNECTOR_NAME}` with no default — an unset env var fails fast at boot rather than silently binding to a placeholder. To re-mint under a new name: change `CONNECTOR_NAME` in `.env`, **also update or recreate the Tunnel Security row** so the new name has a matching bearer (the row is keyed on name), and delete `.connector-state.json`.
- **No LLM, no agent loop, no document handling — *in the connector core*.** The connector itself stays a thin dispatcher. Type 3 bundles are a deliberate exception: a bundled MCP child process can do whatever it needs (LlamaIndex, vector stores, document parsers) because it runs in its own venv, isolated from the connector's Node code path, with its own deps and its own per-entry `.env`. The rule applies to `packages/connector/`; it doesn't apply to what the connector spawns. If you find yourself adding `openai` or document-parser deps to `packages/connector/package.json`, stop — that belongs in a Type 3 bundle under `bundles/<name>/`, not here.
- **Webhook ingress preserves the outbound-only invariant.** The Twilio statusCallback / inbound-webhook story (see [.claude/plans/STATUS-CALLBACK-MCP.md](.claude/plans/STATUS-CALLBACK-MCP.md)) puts the public URL on the *controller* (`https://<controller-host>/api/webhook/<connectorId>/<token>`); the connector consumes events as `webhook` frames over the existing `/mcp-tunnel` WS. The connector opens **no** inbound port for webhook ingress, no per-MCP ngrok, no LB. Every webhook URL is bcrypt-protected per (connectorId, mcp); the URL prefix (rowId) is stable across reconnects but the random tail re-mints on every `webhook-allocate` (the connector pushes the new value to SDK consumers as a fresh `event: url` over the inspector loopback's SSE stream — see [`packages/connector/src/tunnel/webhook-registry.ts`](packages/connector/src/tunnel/webhook-registry.ts)). Don't reintroduce a per-MCP local listener for webhook delivery — that breaks the load-bearing property.
- **Inspector port is localhost-only and carries copy-able webhook URLs.** The inspector at `INSPECTOR_PORT` (default 9090) hosts both the operator UI *and* the SDK ↔ connector IPC routes (`/internal/webhook/stream`, `/internal/webhook/revoke`) used by bundled MCP children to subscribe to webhook events. The Webhooks panel exposes the full bcrypt-protected URL with a copy button by design (operators paste it into Twilio configs). **Never bridge `INSPECTOR_PORT` to a public load balancer or expose it beyond the connector container** — copying the URL out is intentional, and that URL *is* the secret. Same trust boundary as the existing inspector, just made load-bearing by webhook ingress.

## Wire protocol — frames

Defined in [packages/connector/src/tunnel/frames.ts](packages/connector/src/tunnel/frames.ts):

- `register { manifest }` — first frame after WS open
- `manifest-delta { delta }` — diff of `added`/`removed`/`changed` tools
- `rpc { payload }` — opaque MCP JSON-RPC, both directions
- `heartbeat { ts }` — every `policy.heartbeat_interval_ms`
- `goodbye { reason? }` — sent on SIGTERM before WS close
- `webhook-allocate { mcp, ttlSeconds? }` — connector → controller; mint a public URL for `mcp` (`ttlSeconds` is reserved; v1 controller ignores it)
- `webhook-allocate-ack { mcp, url?, error? }` — controller → connector; reply to `webhook-allocate`. Echoes `mcp` for correlation (no requestId — same shape as `register-ack`)
- `webhook { mcp, queryParameters, body, headers?, receivedAt }` — controller → connector; an inbound HTTPS POST routed to `mcp`. `body` is JSON-normalised by the controller (form-urlencoded → object before forwarding); `headers` is allowlisted to `X-Twilio-*` (case-insensitive) + `Content-Type`
- `webhook-revoke { mcp }` — connector → controller; explicit teardown of an allocation. Not sent on WS close (the controller GCs by session)
- `creds-request { mcp, author, envKeys, requestId }` — connector → controller; ask for env values for `mcp`. `author` is `"twilio"` for Twilio-bundled MCPs (controller auto-fills from the tunnel-security row), `"customer"` otherwise. `envKeys` is the de-duped union of every tool's authored `envKeys` hint. `requestId` is connector-minted for correlation.
- `creds-response { requestId, env?, source?, error? }` — controller → connector; reply to `creds-request`. `source` is one of `"twilio-tunnel-row"`, `"operator-entered"`, `"none"` — surfaced verbatim in the inspector status panel. Late arrivals (after the 5s soft-wait) go through the same `supervisor.applyControllerEnv` path as a push.
- `creds-update { mcp, env, source }` — controller → connector; operator updated creds in the controller UI. Connector applies via `supervisor.restart(name, "creds-update")`. Optional `mcpId` for 3rd-party-MCP correlation (v1.1).
- `mcp-config-snapshot { generation, servers }` — controller → connector (v1.1); full 3rd-party MCP roster keyed by `mcpId`. Sent on every `register-ack` (always — even when empty), and as the reply to `mcp-config-resync`. Connector reconciles by diff against running supervisor entries; the yaml is NOT rewritten — controller-supplied roster lives in connector RAM only.
- `mcp-config-delta { generation, added?, updated?, removed? }` — controller → connector (v1.1); steady-state deltas for 3rd-party MCP CRUD. Generation is monotonic; gap → connector requests resync. `removed` carries `mcpId[]`, not names.
- `mcp-config-ack { generation, perMcp }` — connector → controller (v1.1); per-MCP `{mcpId, name, status, error?}` after applying a snapshot or delta. `status: "skipped"` for entries the connector cannot run (e.g. unsupported transport in this connector version).
- `mcp-config-resync { reason }` — connector → controller (v1.1); sent on generation gap (`reason: "gap"`) or boot soft-wait timeout (`reason: "boot"`). Controller MUST reply with a fresh `mcp-config-snapshot`.

Wire-format authority: **[`docs/MCP-PROTOCOL.md`](docs/MCP-PROTOCOL.md)** is the contract for the controller team. Connector-side schemas in [`packages/connector/src/tunnel/frames.ts`](packages/connector/src/tunnel/frames.ts) match it. Backwards compat: an older controller that doesn't know `creds-request` triggers the 5s soft-wait timeout per MCP — the connector logs `warn` and falls back to `dir/.env` for that MCP. WS stays open; not a fatal protocol error.

Inbound `tools/call` uses `name = "${serverName}.${toolName}"`. The connector splits on the first `.`. Some controllers also send a `register-ack` frame back; the connector parses and ignores it (non-spec, but harmless).

`webhook` frames share the WS with `rpc` traffic and `heartbeat`s. Three rules keep that mix safe:
- **No per-frame await.** The TunnelClient's `send()` is synchronous; webhook delivery doesn't block heartbeat scheduling. Don't introduce an async hop on the send path or you'll starve heartbeats under burst load.
- **No chunking.** Webhook frames are single JSON lines like every other frame. The controller caps body at 256 KB (413 over) — that's also the implicit ceiling on tunnel frame size.
- **Webhook latency vs RPC latency.** Twilio's payment / status callbacks are not latency-sensitive (humans say digits). The controller is the synchronous HTTP responder anyway — it returns 200 to the upstream immediately and forwards async over the WS, so the upstream never sees connector queue depth.

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

- **`packages/connector`** — the customer-side process. Config, MCP clients to local servers, WSS tunnel, dispatcher, supervisor (Type 1 child supervisor + drop-in spawner + Type 2/3 connector), inspector UI, CLI (`start` / `init` / `discover` / `register` / `version`). The connector + its `tsx` runtime + the `mcp/` tree are what go in the OCI image.
- **`packages/connector/src/sdk/`** — the surface customer-authored Type 1 servers import. `Tool` interface (incl. optional `envKeys?: string[]`) + `createMcpHttpServer({name, tools, port?, envKeys?})` factory. Re-exported from `@mcp-shim/connector/sdk`. The factory's HTTP server also exposes `/envkeys` returning the de-duped union of every tool's `envKeys` (or, when `opts.envKeys` is set at the server level, that list verbatim) — the supervisor queries it post-spawn so the connector can include it in `creds-request` frames. Server-level `envKeys` exists specifically for **creds-gated MCPs** (e.g. `mcp/bundled/twilio/`) that register zero tools at boot when their creds aren't yet present: the per-tool aggregate would be empty, but the controller still needs to know which keys to populate. **Empty-tools `tools/list` handler:** when `opts.tools.length === 0`, the factory installs an explicit `tools/list` handler returning `{tools: []}` — McpServer wires its own handler lazily on first `registerTool()`, and a tools-empty server would otherwise return `-32601 Method not found` to `tools/list` and crash the connector's `buildManifest` at boot. Don't remove this branch in [`packages/connector/src/sdk/http-server.ts`](packages/connector/src/sdk/http-server.ts) without restoring an equivalent compliance gate — empty-tools is a valid resting state for creds-gated MCPs.
- **`packages/connector/src/sdk/dropin-runner.ts`** — synthesized child entrypoint for drop-in MCPs. Auto-discovers default-exported `Tool` objects from `${DROPIN_DIR}/tools/*.{ts,js}` and calls `createMcpHttpServer({ name: ${DROPIN_NAME}, tools })`. One shared bin parameterized by env, not a per-folder file write.
- **`packages/connector/src/dropin.ts`** — `discoverDropins({ yamlNames })` scans `MCP_DROPIN_DIR`, returns synthesized Type 1 specs (`Extract<HttpServer> & { __dropin: true }`, assignable to `McpServerSpec`). Skips folders with a yaml entry or a hand-written `server.ts`.
- **`packages/connector/src/mcp-supervisor.ts`** — owns the lifecycle of every MCP child (Type 1 hand-written, Type 1 drop-in, Type 2 stdio, Type 2 http, Type 3 bundled). Exposes `register(specs) / startAll() / restart(name, reason) / stopAll()`, applies controller-supplied env via `applyControllerEnv(mcp, env, source, reason)`, tracks per-MCP `McpStatus` (process / credsSource / credsLastUpdated / restartCount / lastRestartReason / toolsCount), and **mutates the SHARED `servers: Map<string, McpServerConnection>`** so the dispatcher and inspector pick up new connections without re-wiring. Replaced the old `src/spawner.ts` (deleted in `feature/mcp-loading`). Auto-port probe + tsx resolution moved here unchanged. **Spawn-mutation invariant:** `spawnChild` mutates the spec's `endpoint` (and stamps a hidden `__port`) post-readiness so `connectServer` works unchanged — but that mutation flips `isType1Spawn(spec)` from `true` → `false`. `stopEntry` MUST clear both fields when `__port` is set so the next `startEntry` re-classifies the entry as a spawn and re-enters `spawnChild`. Without this clearing, a creds-driven restart kills the child and then dials the freed port → ECONNREFUSED. The `__port` gate is what keeps Type 2 http entries' author-supplied endpoints untouched.
- **`packages/connector/src/tunnel/creds-coordinator.ts`** — fans out `creds-request` per MCP after register-ack, awaits the 5s soft-wait, applies responses via `supervisor.applyControllerEnv`. Late `creds-response` frames and `creds-update` push frames go through the same code path. Exposed to the inspector via `mcpActions.reloadCreds(name)` for the per-MCP "Reload creds" button.
- **`mcp/local/sample`** — Type 1 demo. `tools/now.ts`, `slow-echo.ts`, `uuid.ts`, `weather.ts` (weather.gov, US-only) + a 5-line `server.ts`. No `package.json` deps; `zod` resolves to repo root.
- **`mcp/local/crm`** — Type 1 demo: thin client over the mock customer service at `mock/customers/`. Exposes `get_customer` (identity), `get_recent` (most-recent order), `issue_refund` (side-effect). Used by the Refund Eligibility procedure on the controller side.
- **`mcp/external/aviation-weather`** — Type 2 demo. Pure config — README + `.env.example` only. The yaml entry is `command: [npx, "--yes", aviation-weather-mcp]` and the connector spawns the published npm package via stdio.
- **`mcp/bundled/twilio`** — Twilio-authored Type 1. `server.ts` + `tools/*.ts` + `twilio-client.ts`, plus a per-folder `package.json` carrying the `twilio` SDK (kept local so it doesn't leak into the workspace). The connector spawns it via `tsx server.ts` like any other Type 1; it lives under `mcp/bundled/` because Twilio ships it pre-installed in the image, not because it's Type 3. Re-folded in from the prior `../twilio-mcp-shim/` sibling project. **Auth shape: AuthToken-only.** The bundle reads `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`; the API-Key branch was removed deliberately to keep the bundle aligned with the controller's `creds-response` auto-fill (see [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) "Twilio-bundled auto-fill"). The tunnel-handshake row may still be created with a Twilio API Key — that's a controller-side verification step, separate from the bundle's runtime env. Don't reintroduce an `apiKeySid`/`apiKeySecret` branch in [`mcp/bundled/twilio/twilio-client.ts`](mcp/bundled/twilio/twilio-client.ts) without a matching change to the auto-fill table — they have to agree by string.
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

A startup boot log in `main()` prints `authToken: "set (len=N)"` (static-bearer posture) or `authToken: "oauth2 (clientId=...)"` (OAuth2 posture) after the auth presence check. The connector throws and refuses to boot if *neither* posture is configured — symmetric with the `${CONNECTOR_NAME}` interpolation, which throws at YAML load if the env var is unset. Don't soften either check — the failure modes are intentional, and a silently-unauthenticated or unnamed connector is exactly the bug they prevent. Note: a credential that's *set but doesn't match any controller row* boots fine here and gets rejected at the WS handshake with HTTP 401 — that's a controller-side decision (`bearer did not match any tunnel security config` for static, `OAuth2 token mint rejected` for OAuth2), not something we can detect locally before dialing.

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

Primary verification is **interactive via the inspector UI**:
- "MCP Server" panel shows the local MCP servers and their tools.
- "Available Tools" panel lists each discovered tool with a "Ready" verdict.
- "Webhooks" panel lists each MCP's allocated public URL with a copy button (only populated for MCPs that called `createWebhookEndpoint`).
- "MCP Status" panel renders per-MCP `McpStatus` (process state, creds source, restart count + last reason, tools count) with state-colored left borders. Two per-MCP actions: **Reload creds** (forces a `creds-request` for that MCP and restarts on response) and **Restart** (resets the consecutive-failure counter and re-spawns with current env). Same loopback trust boundary as the rest of the inspector — never bridge to a public LB.
- "Frames" panel shows live WS state + every frame in/out (filterable; heartbeats hidden by default). Includes the webhook frames (`webhook-allocate`, `webhook-allocate-ack`, `webhook`, `webhook-revoke`) and the creds frames (`creds-request`, `creds-response`, `creds-update`).
- "Reconnect" button **re-reads the YAML** (`policy` changes), then redials. To pick up changes to `mcp_servers`, restart the script — those connections happen at boot.

There is also a **vitest skeleton** for defensive regression tests. The suite is regression-driven: tests are added when manual scenarios surface real bugs, not for coverage. See [.claude/plans/TEST-SUITE.md](.claude/plans/TEST-SUITE.md) for the living catalog.

```bash
cd packages/connector
npm test          # one-shot run; uses --root ../.. so it sees the root vitest.config.ts
npm run test:watch # watch mode for the active test file
```

Tests live at `packages/connector/tests/**/*.test.ts` mirroring `src/` (peer-tests layout, not colocated — `tsconfig.json`'s `rootDir: "src"` would otherwise compile tests into `dist/` and ship them in the OCI image). Use explicit `import { describe, it, expect } from "vitest"` — globals are off. Shared fixtures land in `tests/helpers/` once the second test needs the same factory.

When adding a test in response to a manual finding: append a row to the catalog table in `.claude/plans/TEST-SUITE.md` with the date, scenario, source file, test file, and status (`failing` → `passing` once the fix lands).

## Inspector UI notes

The inspector lives inside the connector process at `INSPECTOR_PORT` (default 9090) and **binds to `127.0.0.1` only** (enforced in [packages/connector/src/inspector/server.ts](packages/connector/src/inspector/server.ts)'s `server.listen(port, "127.0.0.1", …)`). It is part of the customer side; it does **not** proxy or impersonate the controller. It only renders what *this* connector is doing. Reach it from outside the container via port-forward / exec — never via an LB. Don't relax the bind to `0.0.0.0` or pass an external host argument: the Webhooks panel exposes the bcrypt-protected URL by design and the SDK ↔ connector IPC routes (`/internal/webhook/*`) carry no auth of their own.

Token-based renderer for tool shape cards in [packages/connector/public/app.js](packages/connector/public/app.js): each token is `[cssClass, text]` and gets HTML-escaped at render time. Don't reintroduce regex-based replacement for syntax highlighting — it dragged in control-character ambiguity that the linter rightly complained about.

The left column is draggable; the width is persisted in `localStorage` under `inspector.leftColPx`.

## Config files

| File | Purpose |
|------|---------|
| `packages/connector/connector.yaml`         | live, single source of truth for this connector. Lists every MCP. Carries `tunnel.name` (customer-chosen, identity claim) and references `${CONTROLLER_URL}`, `${TUNNEL_AUTH_TOKEN}`. Gitignored. |
| `packages/connector/connector.yaml.example` | template, committed. |
| `packages/connector/.env`                   | live tunnel env: `CONTROLLER_URL` (HTTPS root, e.g. `https://controller.example.com`), `CONNECTOR_NAME` (must match the controller's Tunnel Security row), and ONE of: `TUNNEL_AUTH_TOKEN` (the `ts_…` bearer minted by a Twilio-Auth-Token / API-Key row) OR `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_TOKEN_URL` (an OAuth 2.0 row). Optional: `INSPECTOR_PORT`, `MCP_BASE_PORT`. Gitignored. |
| `packages/connector/.connector-state.json`  | written by the connector on first register-ack; carries `registrationToken`. Customer never edits; clearing it forces a re-mint. Gitignored. |

`CONTROLLER_URL` is the controller's HTTPS root; it's used for both the register API call and the WS tunnel dial. The connector internally upgrades `https://` → `wss://` and appends the `/mcp-tunnel` path in [packages/connector/src/tunnel/client.ts](packages/connector/src/tunnel/client.ts) before opening the socket. Don't expose the wire scheme or path as a customer-facing config knob — keep it as `https://<host>` everywhere customers touch and let the connector do the upgrade. The controller dispatches `/crelay` (Conversation Relay) and `/mcp-tunnel` on a single port (default 3001), so one DNS entry / one ngrok tunnel covers both.
| `packages/connector/.env.example`           | template, committed. |
| `mcp/{local,external,bundled}/<name>/.env`         | per-MCP live env. Loaded by the connector into *that child's* process only — never leaks across MCPs. Gitignored. |
| `mcp/{local,external,bundled}/<name>/.env.example` | per-MCP template, committed. |

The YAML supports `${VAR}` and `${VAR:-default}` interpolation; unknown vars without a default throw with the variable name and YAML line so the customer can fix the right line. `start-connector.sh` sources `packages/connector/.env` and invokes `node packages/connector/dist/index.js start`. The connector handles registration inline: on the first WS register frame it presents `tunnel.name`, the controller mints a row + token, the connector persists the token in `.connector-state.json`. Subsequent restarts present the token and re-bind to the same row — no separate provisioning step. In Docker, set the same vars via container env — there is no `.env` inside the image; the customer mounts `connector.yaml` at `CONNECTOR_CONFIG` (default `/etc/mcp-connector/config.yaml`) and a writable volume for `.connector-state.json` (or accepts re-mint on every restart, which the controller's dup-name guard catches). The image bundles `mcp/` at `/app/mcp/` for Type 1 entries to spawn from and Type 2/3 `dir:` resolution.

### Per-entry env precedence (subtle)

The plan called this out as the highest-risk piece — read carefully before changing it. Four layers, lowest to highest precedence:

1. `dotenv/config` loads `packages/connector/.env` once at startup → populates `process.env`.
2. `loadConfig` parses the yaml. Top-level `${VAR}` interpolation reads from `process.env` only. For each `mcp_servers[]` entry with `dir:`, the loader reads `<dir>/.env` into a **per-spec env map** (does **not** mutate `process.env`).
3. Inline `env:` map on the yaml entry (rare today; layered above `dir/.env`).
4. **Controller-supplied env from `creds-response` / `creds-update` frames.** The supervisor stores these in a per-MCP `controllerEnv` map and they win on conflict. See `mergeEnv` in [packages/connector/src/mcp-supervisor.ts](packages/connector/src/mcp-supervisor.ts) — the merge order is `process.env ⊕ spec.env (yaml inline + dir/.env) ⊕ controllerEnv`.

When the supervisor launches a Type 1 child / drop-in / Type 2 stdio / Type 3 bundled child, it passes the merged env. Cross-entry leakage is still impossible — child A's `API_TOKEN` (whether from `dir/.env` or controller-supplied) does not reach child B even if both declare the same key.

Per-spawn env-source telemetry: every spawn logs `mcp spawn env-sources` with two arrays — `controller: [...]` and `dirDotEnv: [...]` — listing the env-key names sourced from each layer. Watch the `dirDotEnv` array trend toward `[]` as customers move creds into the controller (D2 deprecation tracker).

Don't replace the per-spec env map with calls to `dotenv.config({path: ...})` in `loadConfig` — that mutates `process.env` and breaks the isolation guarantee. Don't widen the merge order without thinking through the cross-product with `applyControllerEnv` (which restarts the child with the new merged env).

### Env reading rule — empty string == not set

All `process.env` reads in `src/` go through [`src/env.ts`](packages/connector/src/env.ts) (`envString` / `envOptional` / `envNumber`). The whole-module rule: **an empty-string env var is treated as "not set"** — fall back to the documented default. An admin who writes `FOO=` (blank line) in `.env` expects "leave this unset"; `??` previously let `""` flow through (`Number("")=0`, `resolve("")=cwd`, pino throws on empty level). `envNumber` additionally throws an admin-actionable error when set to a non-numeric value (naming the var, the bad value, and the recovery), instead of silently coercing to `NaN`. The single deliberate exception is the YAML `${VAR}` interpolator in [`config.ts`](packages/connector/src/config.ts), which substitutes the literal empty string and lets the zod schema produce a more specific validation error.

Boot-time required-env preflight runs once in [`src/boot/require-env.ts`](packages/connector/src/boot/require-env.ts) (`requireEnv()`) before yaml load or auth resolution. It consolidates every missing required var (`CONNECTOR_CONFIG`, `CONTROLLER_URL`, `CONNECTOR_NAME`, plus the static-bearer-vs-OAuth2 posture) into a single error block so an admin fixes them in one `.env` edit pass. The auth-posture branch is posture-aware: setting `OAUTH_CLIENT_ID` triggers a "you started OAuth2; here's what else you need" message rather than three separate "X is required" lines.

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

The connector's SIGTERM handler calls `supervisor.stopAll()`, which sends SIGTERM to every Type 1 / drop-in / Type 2 stdio / Type 3 child it spawned (with a SIGKILL fallback after timeout). Combined with the script's `trap cleanup EXIT INT TERM` (which `kill 0`s the process group), Ctrl-C cleans up the whole tree.

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
