# Fly.io deployment — mcp-connector

Operator runbook. For customer-facing narrative (why Fly.io, when to graduate to
managed Postgres, etc.) see the sibling [`README.md`](README.md).

## What this deploys

One Fly Machine running `ghcr.io/twilio/mcp-connector:<tag>`, dialing out to a
controller URL over WSS. No public IP, no `[[services]]`, no `[http_service]`.
State (registration token) persists in a 1 GB Fly volume; tunnel identity +
sealed creds live in a Fly Postgres attached as `POSTGRES_URL`.

Reach the inspector via `fly proxy 9090:9090 -a mcp-connector-<CUSTOMER>`.

## Prereqs

1. **flyctl** installed and authed to your Fly org — `fly auth login`.
2. **Controller URL** + **Tunnel Security row** minted in the controller UI.
   Copy the resulting bearer (`ts_...`) or OAuth2 client credentials — you'll
   paste them into the connector's inspector on first boot.
3. **CONNECTOR_NAME** — the Name field on the Tunnel Security row. Must match
   this app's `CONNECTOR_NAME` env var (set via the inspector's Configure
   Tunnel modal, not via `fly secrets`).
4. **(Optional) Mock backend deployed first** — if you're running the demo,
   deploy `examples/mock-backend/` as a separate Fly app in the same Fly org first,
   then update `customer-mcps/crm/.env` with the private DNS URL before you build
   the connector image. See [`../../examples/mock-backend/README.md`](../../examples/mock-backend/README.md).

## Deploy — the short version

Two commands. That's all most operators need:

```bash
# From the repo root:
mcp-connector deploy init --target fly --name acme-prod \
  --controller-url https://your-controller.example.com --yes
mcp-connector deploy apply --target fly
```

`init` writes `fly.toml` at the repo root. `apply` runs the five Fly
operations (`apps create`, `postgres create` + `attach --variable-name
POSTGRES_URL`, `secrets set CONNECTOR_KEY_B64`, `volumes create state`,
`fly deploy`) with idempotency guards — safe to re-run if a step is
interrupted. Then continue at [step 7 (configure the tunnel)](#7-configure-the-tunnel-via-the-inspector).

The rest of this section documents the same operations run by hand, for
operators who need to run individual steps or diagnose failures.

## Deploy — step by step (manual reference)

### 1. Copy the template and set the app name

fly.toml lives at **`deploy/fly/fly.toml`** alongside the other per-platform
artifacts. Every `fly` command in this runbook is invoked from the repo
root with `-c deploy/fly/fly.toml` (Fly's build context is the CWD, not
the fly.toml's directory, and this connector's Dockerfile paths resolve
relative to CWD).

```bash
# From the repo root:
cp deploy/fly/fly.toml.example deploy/fly/fly.toml
# Replace <CUSTOMER> with your customer slug (e.g. acme-prod).
sed -i.bak 's/<CUSTOMER>/acme-prod/g' deploy/fly/fly.toml && rm deploy/fly/fly.toml.bak
```

Or use the scaffold CLI (writes to `deploy/fly/` by default):

```bash
mcp-connector deploy init --target fly --name acme-prod \
  --controller-url https://your-controller.example.com --yes
```

### 2. Create the Fly app (no deploy yet)

```bash
# From the repo root:
fly launch --no-deploy --copy-config -c deploy/fly/fly.toml
```

`--copy-config` uses the fly.toml we just edited instead of Fly's generated one.
When prompted about Postgres/Redis/Sentry, decline — we set them up manually.

### 3. Provision Fly Postgres and attach

```bash
# Creates a Postgres cluster (single-node, unmanaged — fine for demos).
fly postgres create --name mcp-connector-acme-prod-db --region iad --initial-cluster-size 1

# Attach it to the connector app, creating the `mcp_connector` database, and
# exposing the URL as POSTGRES_URL (NOT the default DATABASE_URL).
fly postgres attach mcp-connector-acme-prod-db \
  --app mcp-connector-acme-prod \
  --database-name mcp_connector \
  --variable-name POSTGRES_URL
```

**Why `--variable-name POSTGRES_URL`.** The connector reads `POSTGRES_URL`, not
`DATABASE_URL`. Attaching without this flag will set `DATABASE_URL` and boot
will fail with `POSTGRES_URL is required`.

### 4. Mint the master key and set as a Fly secret

```bash
# 32 raw bytes → base64. Save the base64 somewhere safe (e.g. 1Password);
# rotating requires the value again.
KEY_B64=$(head -c 32 /dev/urandom | base64)
fly secrets set CONNECTOR_KEY_B64="$KEY_B64" --app mcp-connector-acme-prod
```

The entrypoint decodes this into `/etc/mcp-connector/connector.key` at boot.
See `connector/entrypoint.sh` for the decode logic.

### 5. Create the state volume

```bash
fly volumes create state --region iad --size 1 --app mcp-connector-acme-prod
```

Holds `.connector-state.json` (env-mode legacy) and any other writable state.
Under `db` mode the registration token lives sealed in Postgres, so this
volume is belt-and-braces — see [D3 in the deployment plan](../../architectural-plans/CODE-DEPLOY.md).

### 6. Deploy

`fly deploy` silently buffers stdout when piped through `2>&1 | tail` —
Fly's Depot builder only flushes on a real TTY. Redirect to a file so
you can watch build progress live during the ~3 min initial build:

```bash
# From the repo root:
nohup fly deploy -c deploy/fly/fly.toml > /tmp/fly-deploy.log 2>&1 &
tail -f /tmp/fly-deploy.log
```

First deploy takes ~2 minutes (image pull + volume attach + Machine start).
`fly logs -a mcp-connector-acme-prod` should show:

```
authToken: "…"    # or "oauth2 (clientId=…)" — depending on posture
inspector listening on 127.0.0.1:9090
```

Because there's no bearer configured yet (creds live in the DB, which is
empty), you'll see the connector waiting on the Configure Tunnel step. That's
expected.

### 7. Configure the tunnel via the inspector

Open a WireGuard-tunneled port to the Machine's loopback:

```bash
# In one terminal, leave it running:
fly proxy 9090:9090 -a mcp-connector-acme-prod
```

Then in a browser: <http://localhost:9090/>. You'll see the "Configure Tunnel"
modal. Fill in:

- **Controller URL** — e.g. `https://controller.example.com`
- **Connector Name** — must exactly match the Tunnel Security row's Name field
- **Auth posture** — static bearer OR OAuth2 client credentials (matching the
  row type)

Save. Inspector transitions `closed` → `connecting` → **`open`** (green pill).

## Verify

```bash
# Runs the doctor preflight inside the Machine — exit 0 = all green.
fly ssh console -a mcp-connector-acme-prod -C "mcp-connector doctor"
```

You should also see in the inspector:

- **MCP Server panel** — every Type 1 / Type 3 MCP from `connector.yaml` with
  "Ready" verdicts
- **Frames panel** — heartbeats flowing every ~1.5s
- **Webhooks panel** — allocated URLs per MCP that called `createWebhookEndpoint`

## Rotation

### Master key rotation (rare — only if the master key is compromised)

```bash
# 1. Wipe the Postgres schema on the connector's Fly Postgres:
fly ssh console -a mcp-connector-acme-prod-db -C "psql -U postgres -d mcp_connector -c 'DROP SCHEMA mcp_connector CASCADE'"
# 2. Mint and set the new key:
NEW_KEY_B64=$(head -c 32 /dev/urandom | base64)
fly secrets set CONNECTOR_KEY_B64="$NEW_KEY_B64" --app mcp-connector-acme-prod
# 3. `fly secrets set` auto-deploys — the entrypoint writes the new key file,
#    the connector recreates the schema. Reconfigure the tunnel via the
#    inspector (Postgres is empty again).
```

The connector fails-fast at boot if the master key changes without wiping
the schema — the fingerprint check in `encryption_meta` guarantees this.

### Tunnel bearer / OAuth secret rotation

Rotated via the controller UI (**Rotate Secret** button on the Tunnel Security
row). The connector picks up the new value on its next restart; prior value has
a 24 h grace window. No connector-side action needed unless you want to force
the pickup:

```bash
fly machine restart --app mcp-connector-acme-prod $(fly machines list -a mcp-connector-acme-prod -j | jq -r '.[0].id')
```

### Postgres graduation (demo → prod)

Fly Postgres is unmanaged. For production, migrate to a managed service:

```bash
# Point at the managed URL. The connector's schema is re-created idempotently.
fly secrets set POSTGRES_URL="postgres://user:pass@managed-host:5432/mcp_connector" --app mcp-connector-acme-prod
# Delete the Fly Postgres cluster once you've confirmed the connector is happy.
fly apps destroy mcp-connector-acme-prod-db
```

Reconfigure the tunnel via the inspector (fresh empty DB).

## What NOT to do

- **Do NOT add `[[services]]` or `[http_service]`** — publishes the inspector
  on `<app>.fly.dev`, leaking bcrypt-protected webhook URLs.
- **Do NOT `fly ips allocate-v4` or `-v6`** — same effect.
- **Do NOT `fly scale count 2`** — the controller's dup-name guard 409s the
  second Machine. Multi-replica is a future workstream.
- **Do NOT run this app in a different Fly org from the mock** — cross-org apps
  can't reach each other's `.internal` DNS, so the crm drop-in fails.
- **Do NOT enable `auto_stop_machines`** — kills the outbound WSS.
