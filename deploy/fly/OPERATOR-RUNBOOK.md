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
4. **(Optional) CRM demo — mock backend + drop-in** — if you want the crm
   MCP visible in the inspector, follow the "Optional: crm drop-in + mock
   backend" section below. Deploys `examples/mock-backend/` as its own
   private-only Fly app (Postgres-backed customer store) and ships
   `examples/demos/crm/` in the connector image. See
   [`../../examples/mock-backend/README.md`](../../examples/mock-backend/README.md)
   and [`../../examples/demos/crm/README.md`](../../examples/demos/crm/README.md)
   for the per-artifact details.

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
volume is belt-and-braces — see D3 in the `CODE-DEPLOY` design record.

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

## Recovery

### Full app recovery (after `fly apps destroy` or accidental deletion)

If the entire Fly app is gone — not just its Machines — the CI push-to-deploy
path fails at `fly deploy` with `Error: app not found`. `--redeploy-only`
intentionally skips the four bootstrap steps (they need org-level auth the
app-scoped `FLY_API_TOKEN` lacks — see the comment header in
[`.github/workflows/deploy-main.yml`](../../.github/workflows/deploy-main.yml)).

Rebuild locally from the same script CI uses:

```bash
# From the repo root, with flyctl authed to the target Fly org:
./scripts/deploy/fly-deploy.sh
```

The script is idempotent — each of the five steps checks for existing state
before creating (see `applyFly()` in
[`connector/src/deploy/apply.ts`](../../connector/src/deploy/apply.ts) — the
`appExists` / `secretExists` / `volumeExists` guards, plus the "already
exists" swallow on `fly postgres attach`). Deleting only Machines does NOT
require this path — `fly deploy` alone (or the CI's `--redeploy-only`)
recreates them against the existing app.

After a full app recreate, rotate the CI token — the previous token was
minted against the destroyed app instance:

```bash
flyctl tokens create deploy \
  --app <CONNECTOR-APP> \
  --expiry 8760h \
  --name github-actions \
  | gh secret set FLY_API_TOKEN \
      --repo <owner>/<repo>
```

Then trigger CI to verify: any `main` push (or
`gh workflow run deploy-main.yml`) exercises the redeploy path against the
new app.

Tunnel identity + creds sit in the fresh Postgres (empty). Reconfigure via
the inspector's Configure Tunnel modal — same flow as
[step 7](#7-configure-the-tunnel-via-the-inspector).

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

### Optional: `enterprise_knowledge` bundle (pgvector + Ollama sidecar)

The EK bundle needs two things beyond the base connector:

1. **pgvector on the connector's Fly Postgres** (or a separate app — see
   `EK-ON-FLY` design doc for the trust-boundary trade-off). To reuse the
   connector's Postgres, run:

   ```bash
   # Create the DB (skip if already done):
   fly ssh console -a <DB-APP> -C 'sh -c "PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -c \"CREATE DATABASE enterprise_knowledge;\""'

   # Install the extension package. On the default 256 MB Fly Postgres,
   # apt-get resolves deps in >200 MB of RAM and OOM-kills. Scale to 512 MB
   # first (brief DB restart, connector auto-reconnects):
   fly machine update $(fly machines list -a <DB-APP> -j | jq -r '.[0].id') \
     --memory 512 --app <DB-APP> --yes

   fly ssh console -a <DB-APP> -C 'sh -c "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-18-pgvector"'

   fly ssh console -a <DB-APP> -C 'sh -c "PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -d enterprise_knowledge -c \"CREATE EXTENSION IF NOT EXISTS vector;\""'
   ```

   `apt-get install` modifies the container filesystem, which is ephemeral on
   Fly Postgres. A future machine restart from an image update will drop the
   extension package (the extension row in `pg_extension` survives — it's in
   the data volume — but the on-disk `vector.so` / `vector.control` files
   are gone, so `SELECT * FROM tbl_with_vector_col` fails). If you plan to
   restart or upgrade the DB machine, expect to re-run the `apt-get install`
   step. For durable pgvector, either graduate to a managed Postgres that
   ships pgvector, or run a separate Fly Postgres app with pgvector baked
   into a custom image.

2. **Ollama sidecar** — separate private-only Fly app. See
   [`bundled-mcps/enterprise-knowledge/EMBEDDING-SIDECAR.md`](../../bundled-mcps/enterprise-knowledge/EMBEDDING-SIDECAR.md) §"Fly.io" for the walkthrough
   (uses [`deploy/fly/ollama/fly.toml.example`](ollama/fly.toml.example)).

Then set the four EK secrets on the connector app:

```bash
OP_PW=$(fly ssh console -a <DB-APP> -C 'sh -c "echo \$OPERATOR_PASSWORD"' | tail -1 | tr -d '\r')

fly secrets set --app <CONNECTOR-APP> --stage \
  EK_PGVECTOR_DSN="postgres://postgres:${OP_PW}@<DB-APP>.flycast:5432/enterprise_knowledge" \
  EK_EMBEDDER=ollama \
  OLLAMA_URL="http://<OLLAMA-APP>.internal:11434" \
  EK_OLLAMA_MODEL=nomic-embed-text

fly deploy --app <CONNECTOR-APP> --config deploy/fly/fly.toml
```

Use `--stage` so the deploy in the next line picks up the secrets in a single
Machine restart. Confirm via the inspector's MCP Server panel — the
`enterprise_knowledge` server should list its five tools (`local_register`,
`gdrive_register`, `knowledge_query`, `sources_refresh`, `sources_fetch`)
with "Ready" verdicts.

Note: `.flycast` on the DSN works because Fly Postgres apps get a `.flycast`
address allocated automatically. The Ollama sidecar uses `.internal`
because a plain private Fly app doesn't get `.flycast` without a
`[[services]]` block (see EMBEDDING-SIDECAR.md for why we avoid one).

### Optional: `crm` drop-in + mock-backend Postgres store

The `crm` bundled drop-in is a demo customer-service MCP with 9 tools
(identity / order / calendar operations plus `create_customer` and
`create_appointment` write endpoints), 3 prompts, and 1 resource. It
speaks HTTP to a sibling `mock-backend` service which owns the
Postgres store. The design lives in `MOCK-BACKEND-DB` (design record).

Three pieces to stand up:

1. **`crm` database on the connector's Fly Postgres.** Same pattern the
   EK bundle uses (§Optional above):

   ```bash
   fly ssh console -a <DB-APP> -C 'sh -c "PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -c \"CREATE DATABASE crm;\""'
   ```

2. **Deploy `twilio-tool-sdk-mock` (or your own name) as a private-only Fly app.**
   Scaffold the fly.toml + Dockerfile:

   ```bash
   mcp-connector deploy init --target fly-mock --name <SLUG> \
     --app-name <MOCK-APP> --yes
   fly apps create <MOCK-APP> --org <YOUR-ORG>

   OP_PW=$(fly ssh console -a <DB-APP> -C 'sh -c "echo \$OPERATOR_PASSWORD"' | tail -1 | tr -d '\r')
   fly secrets set --app <MOCK-APP> --stage \
     MOCK_POSTGRES_URL="postgres://postgres:${OP_PW}@<DB-APP>.flycast:5432/crm"

   cd examples/mock-backend
   fly deploy --app <MOCK-APP>
   cd -
   ```

   The scaffolded `fly.toml` has NO `[[services]]` / `[http_service]` —
   private-only by contract. Sibling apps in the same Fly org reach the
   mock at `<MOCK-APP>.internal:7400`.

3. **Ship the crm drop-in in the connector image and point it at the mock.**
   The `connector/Dockerfile` already has `COPY examples/demos/crm bundled-mcps/crm`
   after the sample copy. Set the connector's `MOCK_CUSTOMERS_URL` secret
   and redeploy:

   ```bash
   fly secrets set --app <CONNECTOR-APP> --stage \
     MOCK_CUSTOMERS_URL="http://<MOCK-APP>.internal:7400"

   ./scripts/deploy/fly-deploy.sh
   ```

Confirm via the inspector's MCP Servers panel — the `crm` server
should list its nine tools with "Ready" verdicts and expose the two
write endpoints as regular tools (invocable from the inspector's
tool-runner form).

**Local dev caveat.** `bundled-mcps/crm` is `.dockerignore`d — any
local symlink or copy an operator sets up under `bundled-mcps/` for
local dev stays out of the deployed image (the Dockerfile's explicit
COPY is the only path). If a symlink there points at an absolute host
path, forgetting the ignore rule would ship a broken symlink and the
connector would ENOENT at drop-in scan time.

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
