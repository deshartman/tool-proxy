# Environment variables

Every env var the connector reads at boot, grouped by who supplies it.

## Required (deployment platform provides)

Populated by your K8s Secret / Docker Compose secret / Fly secret / cloud
key vault — whichever mechanism your platform uses. The connector fails-fast
at boot with an operator-actionable error if any of these are missing.

| Variable | Purpose |
|---|---|
| `CONNECTOR_KEY_FILE` *or* `CONNECTOR_KEY_B64` | Path to a 32-byte libsodium master key (former) OR base64-encoded key value (latter — decoded to `$CONNECTOR_KEY_FILE` by the entrypoint script on platforms whose secret store is env-only, e.g. Fly.io / Azure Container Apps). |

## Optional overrides (defaults baked in the image)

Set these only when the default doesn't match your infrastructure.

| Variable | Default | Purpose |
|---|---|---|
| `CONNECTOR_CONFIG` | `/etc/mcp-connector/config.yaml` | Path to `connector.yaml` — legacy dev knob. Customers using the derived-image or volume-mount delivery paths don't author this file anymore; controller push + drop-in scanners cover every MCP entry. |
| `INSPECTOR_PORT` | `9090` | The loopback-only inspector UI. Set `0` to disable entirely. **Never expose to a public LB** — the Webhooks panel surfaces bcrypt-protected URLs by design. |
| `INSPECTOR_BIND_ADDR` | `127.0.0.1` | Where the inspector binds. Loopback set: `127.0.0.1` / `::1` / `localhost`. Any other value REQUIRES `INSPECTOR_ALLOW_NONLOOPBACK=1` also be set — the connector otherwise refuses to boot. Prevents a silent typo from exposing copy-able webhook URLs. |
| `INSPECTOR_ALLOW_NONLOOPBACK` | (unset) | Explicit opt-in for non-loopback `INSPECTOR_BIND_ADDR`. Set to `1` for Fly.io deployments using `::` behind the WireGuard mesh (with `fly ips list` empty), where it makes the **machine API** (`/oauth/token`, `/v1/*`) reachable for the controller over `.internal` DNS. It does NOT make the operator dashboard reachable — that requires a loopback caller regardless of bind; see `scripts/fly-inspector.sh`. Do NOT set on any host with a public IP allocated. |

These two remain reserved for the Fly.io WireGuard-mesh case only (see
CLAUDE.md / [`docs/INSPECTOR.md`](INSPECTOR.md)) — they're unrelated to
the machine API's network access (see
[`docs/NETWORK-ACCESS.md`](NETWORK-ACCESS.md)). No new env vars back that
feature: onboarding machine-API clients is entirely DB/UI-driven at
runtime, not env-var/restart-driven — a deliberate choice so onboarding
never requires a redeploy. There is no admin login or session concept at
all; the operator dashboard stays loopback-only unconditionally.
| `MCP_BUNDLED_DIR` | `/app/bundled-mcps` | Where the connector's boot scanner discovers Twilio-shipped MCPs. Baked at image-build time; override only when extending the image via volume mount rather than derived-image `COPY`. |
| `MCP_DROPIN_DIR` | `/var/lib/mcp-connector/customer-mcps` | Where the connector discovers customer-authored Type 1 drop-ins. The derived-image + volume-mount delivery paths both land content here. |
| `MCP_DROPIN_ALLOW_SYMLINK_ESCAPE` | unset (enforced) | **Dev only.** Set to `1` to let a drop-in folder resolve outside `MCP_DROPIN_DIR` via a symlink. Enforced by default so a symlink committed into a read-only production mount cannot point discovery at a writable path — the reviewed artifact would then run unreviewed code with no diff showing it. `scripts/start-connector.sh` sets it because the documented dev workflow symlinks `examples/demos/<name>` into `customer-mcps/<name>`. **Never set this in a deployed container.** |
| `MCP_BASE_PORT` | `7100` | Starting port for the auto-assignment probe for Type 1 drop-in child processes. Bump to avoid collision with anything else in the container's network namespace. |
| `MCP_READINESS_TIMEOUT_MS` | `15000` | How long the supervisor waits for a spawned MCP child's port to accept a connection before it gives up and marks the entry `permanently-failed`. Bump on slower hardware or when many drop-ins boot in sequence (tsx cold-starts compound per-child). Under db mode the failed entry surfaces in the inspector's MCP Status panel; siblings keep booting either way (supervisor's log-and-continue). |
| `LOG_LEVEL` | `info` | Pino level. `debug` for verbose troubleshooting; `warn` in prod if you want quieter logs. |
| `CONNECTOR_VERSION` | `dev` | Version string surfaced in the manifest and boot log. CI stamps this at build time. |
| `HEALTH_PORT` | `9100` | Port for the orchestrator health endpoints, `/livez` and `/readyz`, on their own tiny server bound **`0.0.0.0`**. Set `0` to disable. **Not 9091**: `scripts/start-connector.sh <port>` uses that as a second *inspector* port for the multi-instance dev workflow, so a 9091 default would collide with the documented way of running two connectors. This is the one deliberately non-loopback listener in the connector — it serves exactly two GET routes that disclose a boolean and a reason string, and nothing else. `/livez` never consults the tunnel; `/readyz` does. |
| `CONNECTOR_STATE_DIR` | `/var/lib/mcp-connector/state` | Directory holding `config.json`, the sealed config store. **Dev and tests only** — `scripts/start-connector.sh` gives each multi-instance port its own directory, the job `POSTGRES_SCHEMA` used to do. Operators never set it; the container default is correct, and it is a SUBDIRECTORY of the volume on purpose (`entrypoint.sh` chowns it to `mcp` while the volume root stays root-owned). |

### Multi-instance dev mode (`start-connector.sh <port>`)

When you pass a port arg to the dev launcher, five variables are auto-derived so multiple connector instances can coexist on one host, each with its own tunnel identity:

| Variable | Derivation |
|---|---|
| `INSPECTOR_PORT` | `<port>` (CLI arg always wins over `.env`) |
| `MCP_BASE_PORT` | `7100 + (<port> - 9090) × 100` (spacing avoids drop-in child port collisions across instances) |
| `CONNECTOR_STATE_DIR` | `.local/state-<port>` under the repo root. Per-port so instances don't share a config store. The connector's own default is the production path `/var/lib/mcp-connector/state`, which an unprivileged dev user cannot create — which is why the script must set this. |
| `HEALTH_PORT` | `9100` for port `9090`; `9300 + (<port> - 9090)` otherwise. Kept out of the inspector range so a later instance's dashboard port can't land on an earlier one's health port. Without it every instance binds 9100 and a probe reads the first instance's readiness |
| `AGENTIC_MEMORY_STATE_PATH` | `.local/agentic-memory-<port>/.state.json`, `.env`-overrideable. Without it every instance shares agentic-memory's one module-relative state file |

An **explicitly set** `HEALTH_PORT` that is already taken makes the connector exit at boot rather than run with a probe reporting another process's health; the default port only logs an error. Running several instances outside the dev script: see [deploy/MULTI-INSTANCE.md](../deploy/MULTI-INSTANCE.md).

## Forward proxy (enterprise egress)

Read only if your network mandates a forward proxy. These are **not connector
config** — they are the pre-existing de facto standard vars your ops team
already sets fleet-wide, and the connector honours them rather than adding a
knob of its own. Nothing to set if your hosts have direct egress.

| Variable | Purpose |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | Forward proxy for the `wss://` tunnel dial and other TLS egress. Lowercase wins on conflict (curl's convention). |
| `HTTP_PROXY` / `http_proxy` | Cleartext egress only. Deliberately **not** applied to the `wss://` tunnel — a host that proxies cleartext but not TLS is a real configuration. |
| `ALL_PROXY` / `all_proxy` | Fallback when no scheme-specific var is set. |
| `NO_PROXY` / `no_proxy` | Comma- or whitespace-separated exemptions, matched with curl's semantics: `*` bypasses everything, `example.com` also matches `api.example.com` (suffix on a dot boundary, so `notexample.com` does **not** match), a leading dot is ignored, ports are ignored. Loopback (`127.0.0.0/8`, `::1`, `localhost`, `*.localhost`) is **always** exempt whether listed or not — spawned MCP children live on `127.0.0.1`. |

An empty value counts as unset, per the connector-wide rule that a blank env
var means "leave this at the default".

### The asymmetry worth knowing about

`fetch`-based egress and the WSS tunnel take different paths, and Node treats
them differently:

- The **OAuth token mint** and **Type 2 external MCP endpoints** use `fetch`.
  Node can proxy those itself if you set `NODE_USE_ENV_PROXY=1` (available on
  Node 22, which this image pins).
- The **tunnel dial** uses `ws`, which drives its upgrade through `node:https`.
  `NODE_USE_ENV_PROXY` does not reach it, so the connector attaches a proxy
  agent explicitly (see [`connector/src/tunnel/proxy.ts`](../connector/src/tunnel/proxy.ts)).

The failure this closes is a confusing one: before the explicit agent, a
proxy-mandated deployment on the OAuth2 posture would see the token mint
**succeed** through the proxy and only the tunnel time out — which reads as a
broken controller endpoint rather than a network policy. A dial timeout now
names the proxy it used, or says a proxy is configured but was bypassed.

**Not handled: TLS-intercepting proxies.** A proxy that MITMs with a private
root CA will still fail certificate validation. That needs Node's standard
`NODE_EXTRA_CA_CERTS` pointing at your corporate CA bundle; the connector adds
nothing on top.

## Per-bundle vars (Twilio-shipped MCPs)

Populated via the controller creds UI in production, or the inspector's
session-creds paste in dev. These bundles do not ship a `.env.example`.

### agentic-memory

No required env vars. State persists in `bundled-mcps/agentic-memory/.state.json`
(gitignored, deterministically rehydrates on restart).

## Customer drop-ins (per-MCP dev escape hatch)

For your own drop-ins under `customer-mcps/<name>/`, a `.env` file in the
same folder is picked up as a per-spec env map. In production, prefer the
controller creds UI so credentials never touch disk — but the file-based
fallback exists for offline development.
