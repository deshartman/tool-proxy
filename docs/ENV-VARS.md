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
| `CONNECTOR_STATE_PATH` | `./.connector-state.json` (CWD) | Path to the connector's persisted registration token. Under `db` mode (default) the token lives in Postgres and this file is not used; set only when running `env` mode explicitly. |
| `INSPECTOR_PORT` | `9090` | The loopback-only inspector UI. Set `0` to disable entirely. **Never expose to a public LB** — the Webhooks panel surfaces bcrypt-protected URLs by design. |
| `INSPECTOR_BIND_ADDR` | `127.0.0.1` | Where the inspector binds. Loopback set: `127.0.0.1` / `::1` / `localhost`. Any other value REQUIRES `INSPECTOR_ALLOW_NONLOOPBACK=1` also be set — the connector otherwise refuses to boot. Prevents a silent typo from exposing copy-able webhook URLs. |
| `INSPECTOR_ALLOW_NONLOOPBACK` | (unset) | Explicit opt-in for non-loopback `INSPECTOR_BIND_ADDR`. Set to `1` for Fly.io deployments using `::` behind the WireGuard mesh (with `fly ips list` empty). Do NOT set on any host with a public IP allocated. |
| `MCP_BUNDLED_DIR` | `/app/bundled-mcps` | Where the connector's boot scanner discovers Twilio-shipped MCPs. Baked at image-build time; override only when extending the image via volume mount rather than derived-image `COPY`. |
| `MCP_DROPIN_DIR` | `/var/lib/mcp-connector/customer-mcps` | Where the connector discovers customer-authored Type 1 drop-ins. The derived-image + volume-mount delivery paths both land content here. |
| `MCP_BASE_PORT` | `7100` | Starting port for the auto-assignment probe for Type 1 drop-in child processes. Bump to avoid collision with anything else in the container's network namespace. |
| `LOG_LEVEL` | `info` | Pino level. `debug` for verbose troubleshooting; `warn` in prod if you want quieter logs. |
| `CONNECTOR_VERSION` | `dev` | Version string surfaced in the manifest and boot log. CI stamps this at build time. |

## Legacy (`env` mode only — being removed)

Retained for one release cycle as a rollback lane out of `db` mode. Do NOT
choose these for new deployments. Under `db` mode (default) all four are
IGNORED (a warn logs per var) — creds live in the sealed controllers row,
editable via the inspector UI.

| Variable | Purpose |
|---|---|
| `CONNECTOR_CREDS_SOURCE` | `db` (default) or `env`. |
| `CONTROLLER_URL` | HTTPS root of the controller (env mode only). Must start with `https://` — `http://` is refused at boot. Loopback (127.0.0.1, localhost, ::1) is allowed on any scheme for local mock testing. |
| `CONNECTOR_NAME` | Must exactly match the Tunnel Security row Name in the controller UI (env mode only). |
| `TUNNEL_AUTH_TOKEN` OR (`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_TOKEN_URL`) | Static-bearer OR OAuth2 posture (env mode only, mutually exclusive). |

## Per-bundle vars (Twilio-shipped MCPs)

Populated via the controller creds UI in production, or the inspector's
session-creds paste in dev. These bundles do not ship a `.env.example`.

### enterprise-knowledge

| Variable | Purpose |
|---|---|
| `EK_EMBEDDER` | Must be `ollama` (only supported embedder). |
| `EK_PGVECTOR_DSN` | Postgres connection string for the vector store. |
| `OLLAMA_URL` | Ollama sidecar URL. Default: `http://embedding:11434`. |
| `EK_OLLAMA_MODEL` | Embedding model. Default: `nomic-embed-text` (768-dim). |
| `EK_GDRIVE_AUTH` | GDrive auth mode. `service_account` (headless) or `oauth_user` (browser flow). |
| `EK_GDRIVE_TOKEN_PATH` | Path to the pre-minted OAuth token JSON. Required when `EK_GDRIVE_AUTH=oauth_user`. |
| `EK_GDRIVE_SERVICE_ACCOUNT_KEY` | Inline JSON service-account key. Required when `EK_GDRIVE_AUTH=service_account`. |
| `EK_LOCAL_ROOTS` | Colon-separated list of allowed root directories for local-file source indexing (e.g. `/var/lib/documents:/opt/data`). Unset or empty **disables local file indexing entirely** — `sources_register file://...` returns a refusal. Prevents arbitrary file read via crafted `file://` URIs. |

### agentic-memory

No required env vars. State persists in `bundled-mcps/agentic-memory/.state.json`
(gitignored, deterministically rehydrates on restart).

## Customer drop-ins (per-MCP dev escape hatch)

For your own drop-ins under `customer-mcps/<name>/`, a `.env` file in the
same folder is picked up as a per-spec env map. In production, prefer the
controller creds UI so credentials never touch disk — but the file-based
fallback exists for offline development.
