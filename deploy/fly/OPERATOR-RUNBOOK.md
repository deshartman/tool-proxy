# Fly.io deployment — mcp-connector

Operator runbook. For customer-facing narrative (why Fly.io, topology, backups)
see the sibling [`README.md`](README.md).

## What this deploys

One Fly Machine running `ghcr.io/twilio/mcp-connector:<tag>`, dialing out to a
controller URL over WSS. No public IP, no `[[services]]`, no `[http_service]`.
Tunnel identity, sealed creds and the registration token all live in
`state/config.json` on a 1 GB Fly volume — sealed with libsodium under the
master key from `CONNECTOR_KEY_B64`. **There is no database app.** That volume
is therefore not belt-and-braces; it is the connector's identity.

Reach the inspector with `./scripts/fly-inspector.sh mcp-connector-<CUSTOMER>`.
`fly proxy` alone returns 403 — it arrives from the mesh address rather than
loopback. See ["Open the inspector"](#open-the-inspector) below.

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
operations (`apps create`, `secrets set CONNECTOR_KEY_B64`, `volumes create state`,
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
When prompted about Postgres/Redis/Sentry, decline — the connector needs none
of them. (This runbook used to have a step 3 here that provisioned a Fly
Postgres cluster and attached it as `POSTGRES_URL`, with a warning about Fly's
default `DATABASE_URL` name. Both the step and the foot-gun are gone.)

### 3. Mint the master key and set as a Fly secret

```bash
# 32 raw bytes → base64. Save the base64 somewhere safe (e.g. 1Password);
# rotating requires the value again.
KEY_B64=$(head -c 32 /dev/urandom | base64)
fly secrets set CONNECTOR_KEY_B64="$KEY_B64" --app mcp-connector-acme-prod
```

The entrypoint decodes this into `/etc/mcp-connector/connector.key` at boot.
See `connector/entrypoint.sh` for the decode logic.

### 4. Create the state volume

```bash
fly volumes create state --region iad --size 1 --app mcp-connector-acme-prod
```

**This volume is load-bearing, not belt-and-braces.** It holds
`state/config.json`: the sealed tunnel bearer, the OAuth secret if that is the
posture, and the registration token the controller issued. Destroy it and the
operator must re-run Configure Tunnel, and the re-register then collides on
`name_taken` until someone clears the stale controller row.

Note the subdirectory. Fly mounts the volume `uid: 0, gid: 0, chmod 0755`,
which shadows everything the image created at that path; the connector runs as
`mcp` and cannot write the volume ROOT. `entrypoint.sh` creates and chowns
`state/` (alongside `agentic-memory/` and `customer-mcps/`) while it is still
root, which is why the store defaults to a subdirectory rather than the root.

### 5. Deploy

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

Because there's no bearer configured yet (creds live in the config store, which
is empty on a first deploy), you'll see the connector waiting on the Configure
Tunnel step. That's expected.

### 6. Configure the tunnel via the inspector

One command, from a checkout of this repo:

```bash
./scripts/fly-inspector.sh mcp-connector-acme-prod
```

It starts a relay inside the Machine (the Inspector is loopback-only and
`fly proxy` arrives from the mesh address, so proxy-alone gets a 403), opens the
tunnel, verifies the Inspector answers 200, and prints the URL. Ctrl-C stops
everything and confirms the relay is gone.

While it is open the dashboard is reachable from your Fly organization's private
network, so keep the window short. Details and the by-hand equivalent are in
[README.md](README.md#reach-the-inspector-dashboard).

Then open the URL it prints. You'll see the "Configure Tunnel"
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

- **MCP Server panel** — every discovered MCP (the Twilio-authored drop-ins
  from `/app/bundled-mcps/`, plus anything the customer mounted) with "Ready"
  verdicts
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
exists" swallows are needed any more). Deleting only Machines does NOT
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

Tunnel identity + creds sit in the fresh config store (empty). Reconfigure via
the inspector's Configure Tunnel modal — same flow as
[step 7](#7-configure-the-tunnel-via-the-inspector).

## Rotation

### Master key rotation (rare — only if the master key is compromised)

```bash
# 1. Destroy the state volume. There is NO re-seal path: ConfigStore.open()
#    compares a SHA-256 fingerprint of the key against the one recorded in
#    config.json and refuses to start on a mismatch, so the old store is
#    unusable and must go.
MACHINE=$(fly machines list -a mcp-connector-acme-prod -j | jq -r '.[0].id')
fly machine stop "$MACHINE" --app mcp-connector-acme-prod
VOL=$(fly volumes list -a mcp-connector-acme-prod -j | jq -r '.[] | select(.name=="state") | .id')
fly volumes destroy "$VOL" --yes
fly volumes create state --region iad --size 1 --app mcp-connector-acme-prod

# 2. Mint and set the new key:
NEW_KEY_B64=$(head -c 32 /dev/urandom | base64)
fly secrets set CONNECTOR_KEY_B64="$NEW_KEY_B64" --app mcp-connector-acme-prod

# 3. `fly secrets set` auto-deploys — the entrypoint writes the new key file and
#    the connector writes a fresh empty store. Reconfigure the tunnel via the
#    inspector, and expect a `name_taken` rejection until the stale controller
#    row is cleared (the registration token went with the volume).
```

The connector fails-fast at boot if the master key changes without the store
going with it — the `keyFingerprint` field in `config.json` guarantees this. It
replaced the `encryption_meta` table and does the same job.

**This is why the key belongs in a password manager.** Rotating it is not a
key-swap, it is a full re-onboarding of the connector, including a click on the
controller. Losing it is the same operation.

### Tunnel bearer / OAuth secret rotation

Rotated via the controller UI (**Rotate Secret** button on the Tunnel Security
row). The connector picks up the new value on its next restart; prior value has
a 24 h grace window. No connector-side action needed unless you want to force
the pickup:

```bash
fly machine restart --app mcp-connector-acme-prod $(fly machines list -a mcp-connector-acme-prod -j | jq -r '.[0].id')
```

### Optional: `crm` drop-in + mock-backend Postgres store

The `crm` bundled drop-in is a demo customer-service MCP with 9 tools
(identity / order / calendar operations plus `create_customer` and
`create_appointment` write endpoints), 3 prompts, and 1 resource. It
speaks HTTP to a sibling `mock-backend` service which owns the
Postgres store. The design lives in `MOCK-BACKEND-DB` (design record).

Three pieces to stand up:

1. **A Postgres for the mock, with a `crm` database.** The connector has none
   to share — its config is a sealed file on its own volume — so the mock brings
   its own:

   ```bash
   fly postgres create --name <MOCK-APP>-db --region iad \
     --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
   fly postgres attach <MOCK-APP>-db --app <MOCK-APP> \
     --database-name crm --variable-name MOCK_POSTGRES_URL --yes
   ```

   That `attach` sets `MOCK_POSTGRES_URL` for you, so the manual
   `fly secrets set` in step 2 is only needed if you are pointing at a Postgres
   you already run. `<DB-APP>` below refers to whichever Postgres you used.

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

### State volume snapshots (demo → prod)

This section used to be "Postgres graduation" — how to migrate the connector off
unmanaged Fly Postgres onto Neon / RDS / CloudSQL. Deleted rather than
rewritten: there is nothing to graduate.

The durability question it was answering still exists, in a smaller form.
`state/config.json` holds the sealed bearer and the registration token, so:

```bash
VOL=$(fly volumes list -a mcp-connector-acme-prod -j | jq -r '.[] | select(.name=="state") | .id')
fly volumes snapshots list "$VOL"      # Fly snapshots daily, retains 5 days
fly volumes snapshots create "$VOL"    # on demand, e.g. before an upgrade
```

A snapshot is only half a backup: without `CONNECTOR_KEY_B64` it decrypts to
nothing. Keep the key in a password manager and treat the pair as the unit.

Restoring is rarely the fastest path, though. Re-running Configure Tunnel takes
a minute; the cost of losing the volume is the `name_taken` collision against
the controller's surviving row, which needs one operator click to clear. Weigh
that against maintaining a restore procedure.

## What NOT to do

- **Do NOT add `[[services]]` or `[http_service]`** — publishes the inspector
  on `<app>.fly.dev`, leaking bcrypt-protected webhook URLs.
- **Do NOT `fly ips allocate-v4` or `-v6`** — same effect.
- **Do NOT `fly scale count 2`** — the controller's dup-name guard 409s the
  second Machine. Multi-replica is a future workstream.
- **Do NOT run this app in a different Fly org from the mock** — cross-org apps
  can't reach each other's `.internal` DNS, so the crm drop-in fails.
- **Do NOT destroy or recreate the `state` volume casually.** It is the
  connector's identity, not a cache. See the snapshot section above.
- **Do NOT enable `auto_stop_machines`** — kills the outbound WSS.
