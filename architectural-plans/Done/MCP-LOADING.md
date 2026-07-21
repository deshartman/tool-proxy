# MCP-LOADING — Plan

> **Goal.** Cut the customer's "add an MCP" friction without duplicating the controller's existing config UI + Postgres. The customer's authoring surface shrinks to: (a) drop a `tools/*.ts` folder into the connector image, (b) enter per-MCP creds in the **controller** UI. The connector pulls those creds over the existing WSS tunnel — no second database, no second config UI, no DB sidecar.
>
> **Branch.** `feature/mcp-loading`.
>
> **Status: completed 2026-06-21 (connector side, branch `feature/mcp-loading`).** All connector workstreams shipped across A → E:
>
> - **Workstream A — Drop-in MCP discovery.** W-A1/A2 done. `MCP_DROPIN_DIR` scanner + synthesized child entrypoint via [`src/sdk/dropin-runner.ts`](../../packages/connector/src/sdk/dropin-runner.ts).
> - **Workstream B — Live MCP supervisor.** W-B1/B3 done. [`src/mcp-supervisor.ts`](../../packages/connector/src/mcp-supervisor.ts) owns child lifecycle for Type 1 / drop-in / Type 2 stdio + http / Type 3 bundled, mutates the shared `servers` map, emits per-spawn env-source logs.
> - **Workstream C — Controller-creds protocol.** W-C1/C2/C3/C4 done. Three frames + boot-time soft-wait coordinator + runtime push + envKeys aggregation.
> - **Workstream D — Inspector status panel.** W-D1/D2 done. Per-MCP status pane + reload-creds + restart actions, loopback-only.
> - **Workstream E — Controller-driven 3rd-party MCP roster (v1.1).** W-E1/E2/E3/E4/E5/E6 done. `mcp-config-snapshot/delta/ack/resync` frames + in-memory roster coordinator constructed once per process (survives WS reconnect via `bind()`), auth resolution for all four `McpAuthSpec` shapes (`none` / `bearer` / `header` / `oauth2-client-credentials`), all four HTTP-family transports plus stdio (streamable-http / sse / websocket / http / stdio) routed via `__transportKind`, inspector source badge + mcpId correlation id.
>
> Boot verified: 5 yaml-listed MCPs (sample, crm, apis, aviation-weather, enterprise_knowledge) spawn, manifest builds with 44 tools, `/envkeys` endpoint live on each Type 1 child, `mcp spawn env-sources` log line tracks `dir/.env` deprecation. End-to-end manual exercise of v1.1: aviation-weather (stdio + auth:none) added/removed via the controller UI cleanly. **HTTP+Bearer / HTTP+Header / OAuth2 / SSE / WebSocket roster paths are unit-pinned only — no live-controller manual exercise yet** (defensive tests at `tests/auth/` and `tests/servers/connect-dispatch.test.ts` are the regression contract while those flows mature). Health-check loop (W-B2) and per-folder npm install cache (W-A3) deferred by design — revisit when a real customer scenario justifies them. Controller-side implementation (per `docs/MCP-PROTOCOL.md`) is independent and out of scope for this branch.
>
> 47 test files, **190 passing**. Build clean. Branch local only — `feature/mcp-loading` ref preserved post-merge per standing rule.
>
> **Follow-up regression fixes (2026-06-21).** Three latent bugs surfaced when exercising the "no `.env`, ever" path on the Twilio bundle (creds arrive only via the wire, never via local file):
> 1. **Empty creds-response triggered SIGTERM cascade.** Supervisor's `applyControllerEnv` restarted running children for `{source: "none", env: {}}` payloads; race between SIGTERM and an in-flight HTTP fetch crashed the connector. Fixed by no-op-skip guards (`isEmptyNone`, `envEquals`) in [src/mcp-supervisor.ts](../../packages/connector/src/mcp-supervisor.ts) + error-isolation wrapper `applyEnvSafely` in [src/tunnel/creds-coordinator.ts](../../packages/connector/src/tunnel/creds-coordinator.ts) + `stripEmptyValues` at the wire boundary so `{X: ""}` and `{}` converge.
> 2. **Empty-tools server returned `-32601` to `tools/list`.** `mcp/bundled/twilio/server.ts` registers zero tools at boot when creds are absent; `McpServer` only wires its tools/list handler lazily on first `registerTool()`, so a tools-empty server crashed the connector's `buildManifest`. Fixed in [src/sdk/http-server.ts](../../packages/connector/src/sdk/http-server.ts) — explicit empty-list handler installed when `opts.tools.length === 0`.
> 3. **Type 1 restart skipped respawn.** Post-boot `spawnChild` mutates `spec.endpoint`, flipping `isType1Spawn(spec)` to false. A creds-driven restart killed the child but then dialled the freed port → ECONNREFUSED. Fixed in [src/mcp-supervisor.ts](../../packages/connector/src/mcp-supervisor.ts) — `stopEntry` now clears `endpoint` and `__port` for spawn entries (gated on `__port` so Type 2 author-supplied endpoints stay untouched).
>
> All three pinned by tests under [packages/connector/tests/](../../packages/connector/tests/) — see `tests/sdk/http-server-empty-tools.test.ts`, `tests/mcp-supervisor/apply-controller-env.test.ts`, `tests/tunnel/creds-coordinator.test.ts`. Catalog row in [TEST-SUITE.md](TEST-SUITE.md).
>
> **Follow-up inspector improvements (2026-06-21).** Two surfaced when reviewing the live `creds-response` frame in the Frames panel after the no-`.env` flow worked end-to-end:
> 1. **Creds redaction in the inspector.** The Frames panel's right-pane JSON dump rendered `creds-response.env` and `creds-update.env` values verbatim — the Twilio AuthToken was on screen / in screenshots / screen-shares. Fixed in [packages/connector/public/app.js](../../packages/connector/public/app.js) — `redactFrameForDisplay()` rewrites these frame types so values become `<redacted, len=N>`. Key names stay visible (operators need to see which keys are populated). The one-line summary in the frames list also stops echoing values; it now emits `keys=[...] source=...`. Inspector still binds loopback-only — this is defense-in-depth for the screen-content surface.
> 2. **Keyboard navigation for the Frames list.** ↓/↑ moves and selects (matches click semantics — detail pane updates live), Enter re-scrolls the current selection into view. Skips hidden heartbeats; bails out when typing in inputs or focused on a button/link. [packages/connector/public/app.js](../../packages/connector/public/app.js).
>
> Commit: `1deaded`. No protocol change, no tests required (UI-only).
>
> **Workstream E added (2026-06-21).** Controller-driven 3rd-party MCP roster (`mcp-config-snapshot` / `mcp-config-delta` / `mcp-config-ack` / `mcp-config-resync`). v1.1 of [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) is the contract. Connector-side: **all six workstreams complete.** W-E1 + W-E2 done (frame types, in-memory roster manager wired into boot/lifecycle, supervisor lifecycle helpers, `creds-request.mcpId` enrichment); W-E3 done (`resolveAuthHeaders()` for `none` / `bearer` / `header` + supervisor wiring); W-E4 done (per-supervisor OAuth2 `client_credentials` cache, mint-at-connect / restart-on-401); W-E5 done (SSE + WebSocket outbound transports via `__transportKind` marker on the supervisor spec); W-E6 done (inspector `McpStatus.source` badge + `mcpId` correlation id). **All four auth shapes + four HTTP-family transports + stdio working end-to-end** (still need a manual repro to validate W-E3/W-E4/W-E5 against a live controller — defensive unit tests pin the helpers and dispatch). Commits: `b8c1f65` / `0f2e2e0` / `021d01f` (W-E1/E2 + protocol doc), `b255856` (W-E3), `dc25a1e` (W-E4), `6aab4a7` (W-E5), `56bcaec` (W-E6).
>
> **Wire-level creds encryption plan (2026-06-21).** Inspector redaction is a stop-gap. The next chunk closes the wire-level threat — see sibling plan [.claude/plans/CREDS-ENCRYPTION.md](CREDS-ENCRYPTION.md): X25519 sealed-box (libsodium `crypto_box_seal`), ephemeral connector keypair published on `register`, controller seals every env value before the frame leaves the WS. Closes threats #2–#5 (compromised TLS terminator, controller-side log/observability access, controller-side log-leak bugs, connector-side frame-buffer access). Backwards-compatible additive change to v1.1 of [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md). Connector side ~1.5d; controller side ~2–3d; rolls out per-connector independently. Cross-tracked in [AgenticProcedure/.claude/plans/TODO.md](../../../AgenticProcedure/.claude/plans/TODO.md) under Open → "MCP Tunnel — encrypt creds end-to-end".
>
> **Original status: re-scoped 2026-06-20 (revision 2).** Original plan introduced a Postgres sidecar + UI panels on the connector inspector. That duplicated functionality the controller already has. New scope: the controller is the source of truth for per-MCP credentials and external-MCP config; the connector asks for them over the tunnel. Revision 2 (this version) adds Twilio-bundled-creds reuse, dev-path drop-in mocking, per-MCP status display, and split-out wire-format docs at [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md).
>
> **Self-describing.** A fresh-context Claude reads this file + linked source + [CLAUDE.md](../../CLAUDE.md) + [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) and starts work.

## Context

The customer's mental model today vs. what they actually need to do:

| Customer's expectation | What they have to do today |
|---|---|
| "Add an MCP for our internal orders API" | Author `server.ts` + `tools/*.ts`, edit `connector.yaml`, run `npm install`, rebuild image, redeploy |
| "Give Twilio MCPs my AccountSid" | Edit `mcp/bundled/twilio/.env`, restart |
| "Connect to the Aviation Weather MCP we found on npm" | Edit `connector.yaml` with `command: [npx, "--yes", aviation-weather-mcp]` |
| "See what tools my MCP exposes" | Restart connector, watch logs |

**Two of the four flows can move off the connector entirely** — credential entry and (eventually) external-MCP config — by leaning on the controller's existing UI + DB. Only the *tool implementation* (`tools/*.ts`) is genuinely customer code on the connector side, and even there we can drop the `server.ts` boilerplate.

## Architectural pivot — controller is the credential vault

**Today.** Per-MCP creds live in `mcp/<type>/<name>/.env` files on the connector volume. Customer edits by hand.

**New.** Per-MCP creds live in the **controller's existing Postgres** (alongside `tunnel_security_configs`, `connectors`, etc.). Operator enters them in the controller's existing UI. The connector requests them over the WSS tunnel after register-ack.

**Why this is a major win:**

- **No second config UI.** The connector's inspector stays a minimal observability + test surface. No new forms.
- **No second database.** Postgres sidecar, migrations, AES-GCM encryption helper — all deleted from this plan.
- **No state-file expansion.** `dbPassword`, `encryptionKeySeed` not minted. `.connector-state.json` keeps just `registrationToken`.
- **Trust posture is *better*.** Operator authenticates to the controller (existing IdP / SSO). Connector's outbound-only invariant survives unchanged. Encryption-at-rest is the controller's existing problem, not ours.
- **Controller already owns the operator audit trail.** "Who set the AccountSid for connector X" is a row in the controller's audit log — same shape as every other operator action.
- **Twilio-bundled MCPs reuse tunnel-security row creds.** The controller already stores AccountSid + AuthToken (or AccountSid + ApiKey/Secret, or OAuth2 client) on the `tunnel_security_configs` row used to authenticate this connector. For any `creds-request` whose `author == "twilio"`, the controller fills the response from that row — no separate UI entry. Customers configure Twilio once (when minting the tunnel security row); every Twilio-shipped MCP gets those creds automatically.

**Trade-off accepted.** Controller becomes a hard dependency for any MCP that needs creds. Today it's already a hard dependency at boot (the WS dial fails without it), so this isn't a new ceiling — but it does mean a connector cold-booting with no controller reachable can't run MCPs that need creds. Tested fallback: existing `mcp/<type>/<name>/.env` files keep working as a backstop while we migrate. Removing the .env path is a separate, later decision (per user direction).

## Scope of this plan

Three workstreams. Each is independently shippable.

### Workstream A — Drop-in MCP discovery (was L1)

Customer drops a `tools/` folder into the drop-in dir; connector synthesizes the `server.ts` boilerplate. Eliminates the 5-line per-MCP `server.ts` file.

**Drop-in shape:**

```
${MCP_DROPIN_DIR}/
  crm/
    tools/
      get-recent.ts
      issue-refund.ts
      ...
    package.json         # optional, only if third-party SDK needed
```

**`MCP_DROPIN_DIR` resolution:**

| Environment | Default | Override |
|---|---|---|
| Production (OCI image) | `/var/lib/mcp-connector/customer-mcps/` | env var |
| Local dev | `mcp/local/` (relative to repo root) | env var; `start-connector.sh` sets it |

The OCI image's customer-mount path stays unchanged. For local dev we reuse the existing `mcp/local/` tree as the drop-in source so today's `crm/` and `sample/` keep working without a new mount or symlink. The scanner's "yaml entry trumps drop-in" rule (below) prevents conflicts with folders that *also* appear in `connector.yaml`.

**Boot-time behavior:**

1. Connector scans `${MCP_DROPIN_DIR}/<name>/tools/*.ts`.
2. For each folder, synthesizes a server in memory (or temp file) that imports every `tools/*.ts`, expects each to default-export a `Tool`-shaped object, wires them via `createMcpHttpServer({ name: <folder>, tools: [...auto-discovered] })`.
3. Folder name = MCP name. No yaml entry needed for drop-ins; the spawner spawns them per-folder subprocess (matches today's Type 1 isolation).

**Coexistence with hand-written `server.ts` (locked):**

The scanner activates **only when `server.ts` is absent** in a folder. If a folder has `server.ts`, it's treated as today's hand-written Type 1 — the customer authored the boilerplate deliberately and we don't second-guess it. Migration story: customer deletes their `server.ts`, restarts connector, drop-in discovery synthesizes one. No yaml edit required.

If a folder is *also* referenced from `connector.yaml` (legacy hand-wired Type 1 entries), the yaml entry wins and the drop-in scanner skips that folder. This keeps today's `mcp/local/sample/` and `mcp/local/crm/` yaml entries authoritative until each folder migrates.

**Why per-folder subprocess (not in-process):** crash isolation. A misbehaving customer tool can't crash the connector. Same pattern as today's spawner.

**Why `.ts` only (not `.py`):** Python customer drop-ins remain deferred (existing v1 → v2 boundary preserved). Customers who need Python today either ask Twilio for a Type 3 bundle, or run Python as a Type 2 stdio MCP.

**Surface area:**
- Modify [packages/connector/src/spawner.ts](../../packages/connector/src/spawner.ts) — add a discovery pass that synthesizes specs from drop-in folders.
- New helper to write the synthetic `server.ts` (or use `tsx --eval` with an inline script that imports the tools).
- Boot reports import errors via existing inspector + log paths (no new UI).

### Workstream B — Live MCP supervisor (was L2)

The connector needs to add/remove/restart MCP children at runtime so a controller-pushed credential update takes effect without a full process restart.

**New module: `packages/connector/src/mcp-supervisor.ts`.** Responsibilities:

- Start a Type 1 / Type 2 / Type 3 child given a spec (extends today's `spawner.ts`).
- Stop a child (SIGTERM, then SIGKILL after timeout).
- Restart a child with new env (stop + start).
- Emit `manifest-delta` frames so the controller sees lifecycle events.
- Track per-MCP status (process, last health-check, creds source, restart history) for the inspector status panel.

**Constraints from existing architecture:**

- `sameMcpServers()` in [packages/connector/src/boot/lifecycle.ts](../../packages/connector/src/boot/lifecycle.ts) deliberately refuses live-reload of `mcp_servers` across yaml reloads. The supervisor adds a parallel "controller pushed new creds" path that doesn't go through reconnect logic.
- Manifest-delta frames already exist ([packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts)). No new wire format needed for lifecycle events.
- Per-entry env isolation (CLAUDE.md "highest-risk piece") survives — supervisor still passes per-spec env to each child.

**Health-check + auto-restart:**

| Transport | Liveness check | Cadence |
|---|---|---|
| Type 1 / synthesized (HTTP) | `GET /mcp/healthz` (or cheap `tools/list`) against child's loopback port | `policy.mcp_health_interval_ms` (default 30s) |
| Type 2 stdio / Type 3 venv (stdio) | Process alive (`kill(pid, 0)`) + last-frame-received timestamp | Same cadence |
| Type 2 http (external endpoint) | Opt-in only (network cost). Default off; enable per-entry. | Same cadence when enabled |

Restart policy: 3 consecutive failed checks → restart with exponential backoff (1s, 5s, 30s, cap 5min). After 5 consecutive restart failures, mark MCP "permanently failed" + emit `manifest-delta` removing its tools. Operator-side recovery: existing inspector "Restart MCP" affordance (small addition to today's panel).

**Per-MCP status the supervisor exposes (consumed by Workstream D / inspector):**

```ts
interface McpStatus {
  name: string;
  process: "running" | "stopped" | "restarting" | "permanently-failed";
  lastHealthCheck: { ok: boolean; at: number; consecutiveFailures: number };
  credsSource: "controller" | "dir/.env" | "yaml" | "none";
  credsLastUpdated?: number;        // when controller last sent us creds
  restartCount: number;             // since boot
  lastRestartReason?: string;       // "creds-update" | "health-check" | "manual"
  toolsCount: number;
}
```

### Workstream C — Controller-creds protocol (REPLACES old L0a, L0b, L3, L4, L5)

The connector asks the controller for per-MCP env values over the existing WSS tunnel. Controller stores them in its existing Postgres + UI.

> **Wire format authority.** This section captures the design intent. The exact frame schemas, field validation, and controller-side requirements are in **[`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md)**. Controller-team contracts live there; this plan only describes connector-side flow.

**Three new frames** (full schemas in [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)):

| Frame | Direction | Purpose |
|---|---|---|
| `creds-request` | connector → controller | Ask for env values for a given MCP. Carries `{ mcp, author, envKeys, requestId }`. |
| `creds-response` | controller → connector | Reply to a `creds-request`. Carries `{ requestId, env?, source?, error? }`. |
| `creds-update` | controller → connector | Push: operator updated creds in the controller UI. Carries `{ mcp, env, source }`. |

**Controller behavior the connector relies on (locked):**

1. **Per-connector scoping.** Tunnel is already authenticated. `creds-request` for `mcp=crm` must return creds scoped to *this* connector's `crm` row only. Controller derives the connectorId from the WS session, never trusts a connector-supplied connectorId.
2. **Twilio-bundled auto-fill.** When `author == "twilio"`, the controller fills the response from the `tunnel_security_configs` row used to authenticate this WS. The required mapping by `envKeys`:
   - `TWILIO_ACCOUNT_SID` ← row's accountSid
   - `TWILIO_AUTH_TOKEN` ← row's authToken (when posture is Auth Token)
   - For OAuth2-posture rows: `TWILIO_OAUTH_CLIENT_ID` / `TWILIO_OAUTH_CLIENT_SECRET` (Twilio bundled MCPs that exercise OAuth flows are out of scope today; flagged for revision when needed).
   - The bundled MCPs do NOT consume `TWILIO_API_KEY` / `TWILIO_API_SECRET`. API-Key-posture rows are still accepted by the controller for tunnel-handshake verification, but they do not fuel bundled-MCP auth — see [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) "Twilio-bundled auto-fill".

   Controller never asks the operator for Twilio creds twice. They configured them once at tunnel-security-row mint time.
3. **Auto-create unknown rows.** If the controller has never seen this `(connectorId, mcp)` pair, it creates an empty row, returns `env: {}`, and surfaces the new MCP in the controller UI with the `envKeys` hint pre-populated so the operator knows what to fill in.
4. **`source` field in responses** tells the connector where the value came from. Allowed: `"twilio-tunnel-row"`, `"operator-entered"`, `"none"`. Used by the inspector status display.
5. **Audit logging.** Every `creds-request` and operator-driven `creds-update` writes a row to the controller's existing audit log with connectorId, mcp, and operator identity (for updates).

**Connector-side boot flow (locked: spawn-then-restart with soft-wait):**

1. `register` frame goes out as today.
2. `register-ack` comes back as today.
3. **NEW:** Connector sends a `creds-request` for every MCP in `manifest.servers`, in parallel.
4. **Soft-wait up to 5s** for `creds-response` frames. As they arrive, merge response env into each spec's per-entry env map.
5. After the soft-wait or all responses received (whichever first):
   - Spawn (or restart) every spec via Workstream B with the merged env. Controller-supplied env wins on conflict; missing values fall back to `dir/.env` (D2).
6. `creds-response` frames that arrive *after* the soft-wait still apply — supervisor restarts the affected child with the new env (same code path as `creds-update`).

This avoids two failure modes the alternative ("block boot on creds") would create: a slow controller stalling boot, and a stdio child that needs creds entering an unrecoverable crash-loop because we waited too long.

**Runtime push:**

When the operator updates creds in the controller UI, the controller sends `creds-update`. Connector applies via supervisor restart. Same code path as a late `creds-response`.

**Env precedence (CLAUDE.md "highest-risk piece" extended — locked):**

```
child env = process.env ⊕ spec.dir/.env ⊕ spec.env (yaml inline) ⊕ controller-supplied
                                                                  ↑ winner on conflict
```

The per-spec env map in [packages/connector/src/config.ts](../../packages/connector/src/config.ts) gains a fourth layer at the merge site. Map remains *per-spec* — cross-MCP env leakage still impossible.

**Per-spawn env-source logging (D2 deprecation tracker):**

Every time the supervisor spawns or restarts a child, it logs which source each env var came from at `info` level:

```
mcp=crm spawn key=DB_URL      source=controller
mcp=crm spawn key=API_TOKEN   source=dir/.env       deprecated_path=true
mcp=crm spawn key=PORT        source=process.env
```

Cheap to add, doubles as the migration tracker for D2 follow-up. When `dir/.env` falls to zero across all customer deployments, that's the signal we can remove the second layer of the env merge stack.

**Backwards compat with today's controller (locked):**

Today's controller doesn't know `creds-request`. Connector behavior:

1. Sends `creds-request` after `register-ack`.
2. Waits up to 5s (the soft-wait above) for `creds-response`.
3. If timeout — log `warn` per affected MCP, fall back to `dir/.env` only.
4. Connector keeps the WS open; this is *not* a fatal protocol error. Older controllers continue to function for everything else.

We deliberately did *not* introduce a separate `protocol-capabilities` frame at register time — that's a wire-format negotiation surface we don't need yet. If a third frame type lands later that needs explicit capability gating, revisit then.

**Per-tool envKeys hint (locked):**

Each `Tool` object can declare `envKeys: string[]` listing the env vars it needs. Connector aggregates per-MCP and includes the union as the `envKeys` field of `creds-request` so the controller UI knows which keys to surface. Optional field — tools that don't declare it work today, just without the hint. Authoring rule documented in the SDK's `Tool` interface and in [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md).

### Workstream E — Controller-driven 3rd-party MCP roster (NEW, 2026-06-21)

**Why now.** The controller now has a "New 3rd Party MCP" UI (Name / Description / Transport / URL or Command / Auth). Without a wire-format extension, the customer would still have to hand-edit `connector.yaml` for every 3rd-party MCP — same friction the rest of this plan was built to eliminate. Controller already owns the storage + UI; connector just needs to receive the list and reconcile.

**Architectural property preserved.** The yaml stays the source of truth for **bundled** (Twilio-shipped) and **customer-authored** (Type 1 / drop-in) MCPs. Controller-supplied 3rd-party MCPs live in a separate **in-memory** roster keyed by `mcpId`. The yaml is NOT rewritten. Disjoint sets, no merge conflict resolution needed at the yaml layer — see [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"v1.1 — 3rd-party MCP roster (controller-driven)".

**Identity.** Each 3rd-party entry carries an `mcpId: string` minted by the controller. Opaque to the connector — used for routing creds frames and ack rows. `name` remains the display label + tool-call routing key.

**Push shape — snapshot on connect, deltas during steady state.**

| Frame | Direction | When |
|---|---|---|
| `mcp-config-snapshot` | controller → connector | On every `register-ack` (always sent, even if empty); reply to `mcp-config-resync` |
| `mcp-config-delta` | controller → connector | Steady-state: every operator CRUD action in the controller UI |
| `mcp-config-ack` | connector → controller | After applying a snapshot or delta — per-MCP `{mcpId, name, status, error?}` |
| `mcp-config-resync` | connector → controller | Generation gap detected (`reason: "gap"`) or boot soft-wait timeout (`reason: "boot"`) |

Generation is monotonic per connector. Connector tracks `lastAppliedGeneration`; gap → resync. Reconnect always restarts from the latest snapshot.

**`McpConfigEntry` shape (full schema in [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)):**

```ts
interface McpConfigEntry {
  mcpId: string;
  name: string;
  description?: string;
  transport: "http" | "streamable-http" | "sse" | "websocket" | "stdio";
  url?: string;        // http-family
  command?: string[];  // stdio
  auth: McpAuthSpec;   // SHAPE only — values via creds-response (v1 path)
  envKeys?: string[];
}

type McpAuthSpec =
  | { kind: "none" }
  | { kind: "bearer"; envKey: string }
  | { kind: "header"; headerName: string; envKey: string }
  | { kind: "oauth2-client-credentials";
      tokenUrlEnvKey: string; clientIdEnvKey: string; clientSecretEnvKey: string;
      scopes?: string[] };
```

**Auth attachment — connector side, no proxy subprocess.**

For HTTP-family transports (`http` / `streamable-http` / `sse` / `websocket`), the connector resolves the `auth` shape into outbound HTTP headers at connect time and passes them through the SDK transport's `requestInit.headers`:

- `bearer` → `Authorization: Bearer ${env[envKey]}`
- `header` → `${headerName}: ${env[envKey]}`
- `oauth2-client-credentials` → mint + cache JWT via `client_credentials` grant; reuse [packages/connector/src/auth/oauth-provider.ts](../../packages/connector/src/auth/oauth-provider.ts).

For stdio: env vars passed to the subprocess (existing path); the upstream subprocess is responsible for its own auth.

Spec layer: [`McpServerSpec`](../../packages/connector/src/config.ts) gains a new optional `headers?: Record<string, string>` field. [`servers/http.ts`](../../packages/connector/src/servers/http.ts) passes them via `StreamableHTTPClientTransport`'s `requestInit.headers`.

**WebSocket transport — independent from `/mcp-tunnel`.** A `transport: "websocket"` 3rd-party MCP means the connector dials a separate WS to the upstream MCP server's URL. Completely independent from the connector ↔ controller `/mcp-tunnel` WS — no shared auth, socket, or lifecycle.

**Reconnect.** No persistence. On WS reconnect, the connector receives a fresh `mcp-config-snapshot` and reconciles by diff against the running supervisor entries. Stop entries no longer in the snapshot, start new ones, restart entries with changed specs.

**Backwards compat.** Older controllers don't push `mcp-config-*` frames; connector logs a warn after a 5s boot soft-wait, runs with empty 3rd-party roster, WS stays open. Older connectors ignore the new frames per the unknown-frame rule; controller surfaces this in the row's status badge.

### Workstream D — Inspector status panel (NEW)

The inspector at port 9090 stays minimal/observability-only — no config editing. **One new addition:** per-MCP status display, because creds now come from somewhere else (the controller) and the operator needs to see whether they landed.

**Panel content (per MCP):**

| Field | Source | Example |
|---|---|---|
| Process state | Workstream B `McpStatus.process` | `running` / `restarting` / `permanently-failed` |
| Last health check | Workstream B | `✓ 4s ago` / `✗ 3 consecutive failures` |
| Creds source | Workstream B `credsSource` | `controller (twilio-tunnel-row)` / `controller (operator-entered)` / `dir/.env` / `none — running with empty env` |
| Creds last updated | Workstream B `credsLastUpdated` | `12m ago` / `never` |
| Restart history | Workstream B | `restarted 2 times in last hour, last reason=creds-update` |
| Tools advertised | existing manifest | `count + click-through to Available Tools panel` |

**Per-MCP actions:**

| Button | What it does |
|---|---|
| **Reload creds** | Force-sends a `creds-request` for this MCP. On `creds-response`, supervisor restarts the child with the new env. |
| **Restart MCP** | Resets the consecutive-failure counter and triggers a supervisor restart with current env. |

**Observability gap closed.** When a `creds-update` triggers a supervisor restart, two layers of audit exist: the controller-side audit log (operator action), and the connector-side log line `mcp=crm creds_version_changed restart=true`. The `creds-update` frame itself appears in the existing inspector Frames panel — no new code needed for that surface.

## Stages

| Stage | Workstream | Delivers | Status |
|---|---|---|---|
| **W-A1** | A | `MCP_DROPIN_DIR` env var (default `/var/lib/mcp-connector/customer-mcps/`; dev override to `mcp/local/`) + boot-time scanner that lists drop-in folders. Scanner skips folders that already have `server.ts` or are referenced from yaml. | done — `src/dropin.ts` (`discoverDropins({yamlNames})`); `start-connector.sh` exports `MCP_DROPIN_DIR=$ROOT/mcp/local` for dev |
| **W-A2** | A | Synthesized `server.ts` per folder; auto-discovery of default-exported `Tool` objects from `tools/*.ts`. Per-folder subprocess spawn via existing spawner. | done — `src/sdk/dropin-runner.ts` is the synthesized child entrypoint (one shared bin, parameterized by `DROPIN_DIR` / `DROPIN_NAME` env). Auto-discovers default-export Tools, falls back to first named export with Tool shape. Spawned via `tsx dist/sdk/dropin-runner.js` by the supervisor. |
| **W-A3** | A | Per-folder `npm install` cache (mtime-keyed) for folders with non-empty `dependencies` | not started — deferred. Today the existing `start-connector.sh` install loop covers the only Type 1 folder with a non-empty `dependencies` block (`mcp/bundled/twilio/`). Drop-ins without their own `package.json` resolve framework deps via the workspace hoist. Revisit if a customer drop-in needs an isolated SDK. |
| **W-B1** | B | `mcp-supervisor.ts` with `start(spec) / stop(name) / restart(name, newEnv)`; emits `manifest-delta` on lifecycle. Tracks per-MCP `McpStatus`. | done — `src/mcp-supervisor.ts`. Owns child lifecycle for Type 1, drop-in (Type 1 synthesized), Type 2 stdio/http, and Type 3 bundled. Mutates the SHARED `servers: Map<string, McpServerConnection>` so the dispatcher / inspector pick up new connections without re-wiring. The old `src/spawner.ts` was deleted. |
| **W-B2** | B | Health-check loop (HTTP + stdio); 3-failure restart trigger; 5-failure permanent-failed state | not started — deferred. The current restart path is creds-driven (a `creds-update` frame triggers `supervisor.restart`), not health-driven. The `McpStatus.process` enum already carries `permanently-failed` so a future health loop slots in without changing the inspector wire shape. Revisit when a flake-recovery story is needed. |
| **W-B3** | B | Per-spawn env-source logging (D2 deprecation tracker) | done — supervisor emits `mcp spawn env-sources` per spawn with `controller`/`dirDotEnv` arrays of env-key names. Watch the `dirDotEnv` array trend toward `[]` as customers move creds into the controller. |
| **W-C1** | C | Frame types in `frames.ts` (per [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)); serialization; round-trip tests with controller fake | done — `CredsRequestFrame` (outbound), `CredsResponseFrame` / `CredsUpdateFrame` (inbound) in `src/tunnel/frames.ts`; `CredsSource` literal type. Round-trip tests against a controller fake are not yet in the suite — add when controller-side lands and we can pin a real exchange. |
| **W-C2** | C | Boot-time `creds-request` per MCP after register-ack; 5s soft-wait; spawn-then-restart via supervisor; backwards-compat fallback to `dir/.env` | done — `src/tunnel/creds-coordinator.ts` `requestAllAtBoot(...)` fans out per-MCP `creds-request` frames in parallel after a successful register-ack, awaits the 5s soft-wait, warns on still-pending. Late `creds-response` arrivals trigger `supervisor.restart` via the same code path as `creds-update`. Backwards compat: timeout falls back to `dir/.env` (handled by env merge order). |
| **W-C3** | C | Runtime `creds-update` handler; supervisor restart with new env; manifest-delta emitted | done — coordinator `handleUpdate(frame)` applies env via `supervisor.applyControllerEnv`; supervisor restart refreshes the manifest and pushes a delta. |
| **W-C4** | C | `envKeys: string[]` SDK field; aggregation in `creds-request` | done — `Tool.envKeys?: string[]` (SDK), `/envkeys` route on every Type 1 SDK server returns the de-duped union, supervisor's `fetchEnvKeys(name)` queries it post-spawn and feeds the `envKeys` field of `creds-request`. |
| **W-D1** | D | Per-MCP status panel in inspector — process, health, creds source, restart history, tools count | done — "MCP Status" pane between Webhooks and Frames. Renders `McpStatus` per MCP with state-colored left borders (`running` / `stopped` / `restarting` / `permanently-failed`). SSE `mcpStatuses` event refreshes live. |
| **W-D2** | D | "Reload creds" + "Restart MCP" per-MCP actions | done — `/mcp/reload-creds` and `/mcp/restart` POST routes on the inspector; UI buttons wired through `invokeMcpAction(...)`. Inspector loopback only (existing trust boundary). |
| **DOC1** | — | `docs/MCP-PROTOCOL.md` published with wire format, frame schemas, controller-side requirements, examples | done — `docs/MCP-PROTOCOL.md` is the wire-format contract. Connector-side frames in `src/tunnel/frames.ts` match it; controller team implements against the doc. |
| **DOC2** | — | `docs/MCP-PROTOCOL.md` v1.1 — adds `mcp-config-snapshot` / `mcp-config-delta` / `mcp-config-ack` / `mcp-config-resync` for 3rd-party MCP roster; adds optional `mcpId` to creds frames | done (2026-06-21) — additive over v1; `Versioning` section bumped. Controller team implements against §"v1.1 — 3rd-party MCP roster (controller-driven)". |
| **W-E1** | E | `McpConfigSnapshotFrame` / `McpConfigDeltaFrame` / `McpConfigAckFrame` / `McpConfigResyncFrame` types in `src/tunnel/frames.ts`; `McpConfigEntry` + `McpAuthSpec` types; optional `mcpId?` on `CredsRequestFrame` / `CredsUpdateFrame` | done (2026-06-21, commit `b8c1f65`) — types committed; `TunnelFrame` and `InboundTunnelFrame` unions extended. |
| **W-E2** | E | In-memory roster manager (`src/tunnel/mcp-config-coordinator.ts`): tracks `lastAppliedGeneration`, applies snapshot/delta via supervisor diff, emits ack, requests resync on gap, emits resync at boot soft-wait timeout | done (2026-06-21, commits `b8c1f65` + `0f2e2e0`) — coordinator wired into `boot/lifecycle.ts` alongside `CredsCoordinator`. New supervisor helpers added (`hasEntry` / `registerOne` / `startOne` / `replaceSpec` / `unregister`). Distinguishes yaml-vs-roster name collisions in the ack error string. `creds-request.mcpId` enrichment wired through `requestCredsForAllMcps` and the inspector "Reload creds" path — yaml-listed entries omit `mcpId`, controller-roster entries carry it. |
| **W-E3** | E | Auth attachment: `McpServerSpec.headers?: Record<string, string>` field; `servers/http.ts` passes through `StreamableHTTPClientTransport.requestInit.headers`; auth resolution helper translates `McpAuthSpec` + creds env into headers | done (2026-06-21, commit `b255856`) — `src/auth/resolve-mcp-auth.ts` covers `none` / `bearer` / `header`. Supervisor calls `resolveSpecHeaders()` inside `startEntry` right before `connectServer`, so a creds-update → restart cycle re-resolves naturally. `auth?: McpAuthSpec` added to the http-server zod schema; coordinator stamps it; supervisor reads it. Empty-string env values treated as missing (matches `stripEmptyValues` at the wire boundary). 11 defensive unit tests at `tests/auth/resolve-mcp-auth.test.ts`. |
| **W-E4** | E | OAuth2 `client_credentials` integration for 3rd-party MCPs — reuse `src/auth/oauth-provider.ts` per-entry; cache + refresh per-MCP | done (2026-06-21, commit `dc25a1e`) — `src/auth/resolve-mcp-auth-async.ts` plus per-supervisor `oauthCache: Map<key, OAuthClientCredentialsProvider>`. Cache key = `${tokenUrl} ${clientId} ${clientSecret}` so two MCPs with identical OAuth2 creds reuse one cached JWT; rotation invalidates by key mismatch; mint failure evicts so next attempt mints fresh. Strategy: mint-at-connect, restart-on-401 (chosen over a fetch-override wrapper to avoid coupling to SDK transport internals). 10 defensive tests at `tests/auth/resolve-mcp-auth-async.test.ts`. |
| **W-E5** | E | SSE + WebSocket connector-side transport handlers for upstream MCPs | done (2026-06-21, commit `6aab4a7`) — `src/servers/sse.ts` + `src/servers/websocket.ts`. The wire-side `transport` is multi-valued (http / streamable-http / sse / websocket / stdio); the supervisor-side `McpServerSpec` stays two-valued (http / stdio). The four HTTP-family wire variants collapse to the `http` supervisor spec, with the SUB-transport carried via `__transportKind` (mirrors `__dropin` / `__port`). `servers/connect.ts` dispatches on it. WebSocket caveat: the SDK transport accepts only a URL — custom headers from the W-E3/W-E4 resolver are dropped with a warn; operators on a WebSocket upstream must embed auth in the URL. SSE forwards `spec.headers` through `requestInit.headers` on recurring POSTs. 7 defensive tests at `tests/servers/connect-dispatch.test.ts` + `tests/tunnel/mcp-config-coordinator.test.ts`. |
| **W-E6** | E | Inspector: `McpStatus.source: "controller-config"` badge; `mcpId` displayed in the per-MCP card | done (2026-06-21, commit `56bcaec`) — `McpStatus` gains `source: "yaml" \| "controller-config"` + optional `mcpId`. `register()` defaults to `yaml`; coordinator's `addEntry` / rename branch passes `{ source: "controller-config", mcpId }` to `registerOne()`. Inspector renders source as a small badge on the right of the MCP name row (muted "yaml" pill vs accent-coloured "controller" pill); `mcpId` shown as a separate `<code>` line in the meta block for operator-side correlation with the controller's row. 5 defensive tests at `tests/mcp-supervisor/status-source.test.ts`. |

**Ship order followed:** DOC1 → W-A1 → W-A2 → W-B1 → W-B3 → W-C1 → W-C4 → W-C2 → W-C3 → W-D1 → W-D2.

**Workstream E ship order (complete, 2026-06-21):** DOC2 → W-E1 → W-E2 → W-E3 → W-E4 → W-E5 → W-E6.

W-A3 and W-B2 deferred (see status notes).

## Architectural properties this plan is committed to

- Synthesized `server.ts` is per-folder subprocess (not in-process). Crash isolation preserved.
- Per-MCP env isolation extends to four layers: process.env ⊕ dir/.env ⊕ yaml inline ⊕ controller-supplied. Controller wins; cross-MCP leakage remains impossible.
- Health-check + auto-restart at three-consecutive-failure threshold; reuses tunnel reconnect's backoff shape ([packages/connector/src/tunnel/reconnect.ts](../../packages/connector/src/tunnel/reconnect.ts)).
- No new database. No new connector-side config UI. Inspector grows a single status panel; that's all.
- Outbound-only invariant survives — `creds-request` / `creds-response` / `creds-update` ride the existing tunnel.
- Trust boundary stays per-MCP server; controller-supplied env is gated by which MCPs the connector chose to declare. Controller scopes responses by the WS-authenticated connectorId, never trusts a connector-supplied id.
- Twilio-bundled MCPs reuse the tunnel-security row's creds — operator never enters Twilio creds twice.

## Test-suite hooks

Cross-refs into [TEST-SUITE.md](TEST-SUITE.md):

- **New env-var coverage row.** `MCP_DROPIN_DIR` (default `/var/lib/mcp-connector/customer-mcps/`; dev override `mcp/local/`).
- **New phase 4b — runtime supervision** between Phase 4 (boot-time spawn) and Phase 5 (steady state). Tests:
  - child dies → restart fires
  - transient failure (1–2 fails) → no restart
  - 3 consecutive failures → restart with backoff
  - 5 consecutive restart failures → permanent-failed; tools removed via manifest-delta
  - manual "Restart MCP" resets counter
- **New phase 8b — creds protocol** between Phase 8 (steady state) and Phase 9 (fault & recovery). Tests:
  - register-ack triggers per-MCP `creds-request`
  - 5s soft-wait honored
  - missing controller side (timeout) returns empty + falls back to `dir/.env` gracefully
  - `creds-update` triggers supervisor restart with new env
  - env precedence: controller > yaml inline > dir/.env > process.env
  - twilio-author MCP gets `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from tunnel-security row (controller-fake test)
  - per-spawn env-source log line emitted per key
- **Synthetic-server tests:** auto-discovery of default-exported `Tool` objects; folder with no tools → log + skip; folder where one tool's import throws → other tools still load; yaml entry trumps drop-in for same name; folder with `server.ts` skipped by scanner.
- **Frame round-trip tests:** new frame types serialize/deserialize cleanly; unknown frame from a yet-to-update controller is logged + ignored; protocol version handshake (if added) survives mismatched versions.
- **Inspector status panel tests:** McpStatus rendering for each process state; "Reload creds" → frame goes out + status updates on response; "Restart MCP" → counter resets + spawn fires.

Add catalog rows as each W-stage's PR opens.

## Decisions locked

| # | Decision | Rationale |
|---|---|---|
| **D1** | Controller is source of truth for per-MCP creds | Reuses controller's existing Postgres + UI + audit log; deletes Postgres sidecar, AES-GCM helper, three inspector panels from prior plan |
| **D2** | Per-folder `dir/.env` keeps working as fallback | Local-dev keeps working; migration to controller-stored is opt-in. **User direction (2026-06-20):** keep for now while testing, remove after stable. W-B3 logs the deprecated path per spawn so we can track when zero customers depend on it. |
| **D3** | `.ts` only in drop-in (not `.py`) | Python customer drop-ins remain deferred to v2 (architectural property: Python = Twilio-shipped) |
| **D4** | Per-tool `envKeys: string[]` aggregated by connector | Drift risk lower than per-MCP `_meta.ts`; declaration lives next to consuming code |
| **D5** | Per-folder subprocess for drop-in (not in-process) | Crash isolation; matches today's Type 1 spawn shape |
| **D6** | No UI editing of tool source | UI surfaces fact + creds-entry on the controller; source comes through deploy pipeline |
| **D7** | Inspector grows ONE status panel, no config panels | Controller already has config. Status panel earns its keep because creds come from elsewhere — operator needs to see whether they landed |
| **D8** | Three new frames: `creds-request`, `creds-response`, `creds-update` | Stay on existing WSS tunnel; outbound-only invariant unchanged |
| **D9** | Twilio-bundled MCPs auto-fill from tunnel-security row | Customer entered AccountSid + AuthToken (or ApiKey/Secret, or OAuth2) once when minting the row. Twilio MCPs reuse those creds — never asked twice. **Bundle-side auth shape is AuthToken-only** (revised 2026-06-21): `mcp/bundled/twilio/twilio-client.ts` reads only `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`. ApiKey/OAuth2-posture rows still authenticate the *tunnel*, but they do not auto-fill bundled-MCP env. Customer on a non-AuthToken posture provides AuthToken separately (sibling row, or `mcp/bundled/twilio/.env`). |
| **D10** | `MCP_DROPIN_DIR` defaults to `/var/lib/mcp-connector/customer-mcps/` in prod, `mcp/local/` in dev | Dev keeps using existing `mcp/local/` tree without symlinks; OCI image keeps clean prod-mount path |
| **D11** | Boot timing: spawn-then-restart with 5s soft-wait | Avoids slow-controller stalling boot AND avoids stdio crash-loop from blocking boot indefinitely |
| **D12** | Backwards compat: 5s timeout on `creds-request`, fall back to `dir/.env`, log warn | Older controllers keep working; no separate `protocol-capabilities` negotiation needed |
| **D13** | Per-MCP scoping enforced controller-side via WS-authenticated connectorId | Connector never supplies its own connectorId in `creds-request`; controller derives it. Closes the cross-connector creds-leak path. |
| **D14** | Drop-in scanner activates only when `server.ts` is absent AND folder isn't in yaml | Hand-written Type 1 stays authoritative; migration is "delete server.ts → restart" |
| **D15** | Wire format spec lives in `docs/MCP-PROTOCOL.md`, not in this plan | Plan describes intent; docs/ is the controller-team contract. Splits "what we're building" (here) from "what to implement" (there). |
| **D16** | 3rd-party MCP roster comes from the controller as snapshot+deltas; lives in connector RAM only — yaml is NOT rewritten | Yaml stays the customer's source of truth for bundled + customer-authored MCPs. Controller-supplied roster is keyed by `mcpId` (controller-minted), reconciled at boot from a snapshot frame, mutated during steady state via deltas with monotonic `generation`. No persistence on the connector — reconnect always restarts from a fresh snapshot. (2026-06-21) |
| **D17** | Auth on outbound 3rd-party MCP HTTP calls is attached **inside the connector** (not via a proxy subprocess) | Connector resolves `auth: McpAuthSpec` + creds env into HTTP headers at connect time and passes them through the SDK transport's `requestInit.headers`. New `spec.headers` field on `McpServerSpec`. Avoids a per-3rd-party-MCP child process; keeps the existing dispatcher → SDK path. Stdio MCPs continue to receive creds via env. WebSocket transport (`transport: "websocket"`) is a **separate WS** from the connector to the upstream MCP — completely independent of the connector ↔ controller `/mcp-tunnel` WS. (2026-06-21) |

## Cut from the prior plan (preserved for traceability)

The earlier draft of this plan introduced these — **all removed** in the 2026-06-20 rewrite:

- ~~Postgres sidecar (Q9, L0a)~~ — controller's existing Postgres handles it
- ~~`pg` client + migrations + `_migrations`/`external_mcps`/`mcp_credentials`/`audit_log` tables (L0b)~~ — duplicates controller schema
- ~~AES-GCM encryption helper + `encryptionKeySeed` in state file (Q12)~~ — controller's encryption-at-rest covers it
- ~~`dbPassword` minted into `.connector-state.json` (Q10)~~ — no DB to authenticate against
- ~~`docker-compose.dev.yml` for local Postgres (Q15)~~ — no local DB needed
- ~~External MCPs UI panel (L3)~~ — controller's UI handles it
- ~~Credentials UI panel (L4)~~ — controller's UI handles it
- ~~Drop-in MCPs UI panel (L5)~~ — surfaced through existing MCP Server panel + new status panel; no separate config panel
- ~~Bundled MCPs hardening / Yaml-optional boot / Paste-React migration (L6, L7, L8)~~ — out of scope; revisit when justified

## Cross-references

- [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) — **the wire-format contract**. Frame schemas, controller-side requirements, examples. Authoritative for Workstream C and the controller team's implementation.
- [CREDS-ENCRYPTION.md](CREDS-ENCRYPTION.md) — sibling plan. End-to-end creds encryption over the tunnel (X25519 sealed-box, v1.1 additive). Picks up where this plan's wire-format ends.
- [DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md) — sibling plan. Stage G (multi-replica WSS) no longer simplified by a shared Postgres (we don't have one). Active/passive election remains a controller-side decision per the original DEPLOY plan.
- [CLAUDE.md](../../CLAUDE.md) — "Three MCP integration patterns"; per-entry env precedence rule (extended in W-C2 to include controller-supplied env as the highest-precedence layer).
- [TEST-SUITE.md](TEST-SUITE.md) — Lifecycle map; env-var coverage. New phases 4b (runtime supervision) and 8b (creds protocol) added.
- [packages/connector/src/spawner.ts](../../packages/connector/src/spawner.ts) — Today's boot-time spawn; W-A2 generalizes for synthesized server.ts; W-B1 makes runtime.
- [packages/connector/src/config.ts](../../packages/connector/src/config.ts) — Per-spec env loader; W-C2 extends with controller-supplied env at the top of the merge stack.
- [packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts) — W-C1 adds three frame types.
- [packages/connector/src/boot/lifecycle.ts](../../packages/connector/src/boot/lifecycle.ts) — W-C2 hooks `creds-request` after register-ack; `sameMcpServers()` stays untouched (the supervisor's runtime path bypasses it deliberately).
- [packages/connector/src/inspector/server.ts](../../packages/connector/src/inspector/server.ts) — W-D1 + W-D2 add the status panel and per-MCP actions.
- [mcp/local/crm/server.ts](../../mcp/local/crm/server.ts) — Reference for the boilerplate that W-A2 makes synthesized.
- [OUTPUT-SCHEMA.md](OUTPUT-SCHEMA.md) — `Tool` shape; W-C4 extends with `envKeys: string[]` field.

## Future work flagged for later

- **Wire-level creds encryption** — covered by [CREDS-ENCRYPTION.md](CREDS-ENCRYPTION.md). X25519 sealed-box; ephemeral connector keypair on `register`; controller seals every value with libsodium `crypto_box_seal` before the frame leaves the WS. Connector decrypts only at supervisor boundary — inspector and frame buffer never see plaintext. v1.1 additive, backwards-compatible.
- **Removing `dir/.env` entirely** (D2 follow-up). W-B3 surfaces per-spawn deprecation logs. Once they go to zero across customer deployments, deprecate the .env path in a release note + boot-time warning, then remove the second layer of the env merge stack one release later.
- **Yaml-optional boot.** If/when the controller eventually pushes the *list* of external MCPs (not just creds), `connector.yaml` can shrink to just `tunnel:` + `policy:`. Out of scope for this plan.
- **Inspector Paste-React migration.** Only if the inspector grows past its current observability + status scope. With this plan keeping the inspector lean, that justification recedes.
- **Protocol version handshake.** If a fourth or fifth frame type lands and we need explicit capability gating, add a `protocol-capabilities` frame at register time. Out of scope today; the 5s timeout fallback covers backwards compat for the three frames in this plan.



