# Environment variables

Every env var the connector reads at boot, grouped by who supplies it.

## Required (deployment platform provides)

Populated by your K8s Secret / Docker Compose secret / Fly secret / cloud
key vault — whichever mechanism your platform uses. The connector fails-fast
at boot with an operator-actionable error if any of these are missing.

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Full connection string for the connector's Postgres database. Holds the sealed `controllers` row (tunnel identity + creds). |
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
| `POSTGRES_SCHEMA` | `mcp_connector` | Postgres schema for the `controllers` + `encryption_meta` tables. Auto-derived by `scripts/start-connector.sh` in multi-instance mode (see below); an explicit env value wins. |

### Multi-instance dev mode (`start-connector.sh <port>`)

When you pass a port arg to the dev launcher, three of the above variables are auto-derived so multiple connector instances can coexist on one host, each with its own tunnel identity:

| Variable | Derivation |
|---|---|
| `INSPECTOR_PORT` | `<port>` (CLI arg always wins over `.env`) |
| `MCP_BASE_PORT` | `7100 + (<port> - 9090) × 100` (spacing avoids drop-in child port collisions across instances) |
| `POSTGRES_SCHEMA` | `mcp_connector` when `<port>=9090` (historical default, preserves state); else `mcp_connector_<port>`. An explicit env value wins. |

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
