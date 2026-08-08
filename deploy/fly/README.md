# Fly.io

The connector's dial-out-only shape maps cleanly onto Fly Machines: single Firecracker VM, no load balancer, outbound TLS 443 by default, and `fly proxy` for reaching the loopback inspector without exposing anything publicly.

If you want to skip the walkthrough and copy-paste, the CLI renders both apps' manifests for you:

```bash
mcp-connector deploy init --target fly --name <customer> --controller-url https://your-controller.example.com --yes
mcp-connector deploy init --target fly-mock --name <customer> --yes  # only for the demo mock backend
```

## Deployment shape

Two Fly apps in the same Fly organization:

```
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ mcp-connector-<CUSTOMER>     │          │ mock-customers-<CUSTOMER>    │
│  - dial-out WSS → controller │          │  - HTTP :7400                │
│  - Fly Postgres attached     │  ← ─ ─ ─ │  - in-memory fixtures        │
│  - inspector 127.0.0.1:9090  │          │  - no public IP              │
└──────────────────────────────┘          └──────────────────────────────┘
        (fly proxy 9090:9090)                 http://mock-customers-<CUSTOMER>.internal:7400
                                                          (Fly private DNS, IPv6, WireGuard mesh)
```

The mock app is optional — a stand-in for a customer's real CRM backend. In a real deployment, only the connector app exists; the crm drop-in points at the customer's actual API.

## Prereqs

Beyond the [common prereqs](README.md#prereqs-every-cloud):

- **flyctl** installed and authed: `fly auth login`.
- **A Fly organization** with billing set up (the connector Machine + Fly Postgres runs ~$3–5/month idle).

## Deploy the connector

Two commands. That's it.

```bash
# 1. Generate deploy/fly/fly.toml. Sits alongside per-platform artifacts
#    for the other deploy targets (deploy/helm/, deploy/terraform/, etc.).
#    `deploy apply --target fly` always runs fly commands from the repo
#    root with `-c deploy/fly/fly.toml` so the build context (CWD) is
#    the full repo — Dockerfile paths in the fly.toml resolve to
#    connector/Dockerfile as expected.
mcp-connector deploy init --target fly --name acme-prod \
  --controller-url https://your-controller.example.com --yes
# Result: ./deploy/fly/fly.toml.

# 2. Deploy — creates the Fly app + Postgres + master key + state volume,
#    then runs `fly deploy -c deploy/fly/fly.toml`. Idempotent — safe to
#    re-run if any step is interrupted. Foreground so you see build
#    progress live.
mcp-connector deploy apply --target fly
```

Under the hood `deploy apply` runs the five Fly operations you'd otherwise type by hand: `fly apps create`, `fly postgres create + attach --variable-name POSTGRES_URL` (Fly's default `DATABASE_URL` doesn't match what the connector reads), `fly secrets set CONNECTOR_KEY_B64`, `fly volumes create state`, and finally `fly deploy`. See [`connector/src/deploy/apply.ts`](../../connector/src/deploy/apply.ts) for the exact sequence.

### Push-to-deploy from `main`

Once the first bootstrap deploy above has run (locally, with a full-user Fly login), ongoing redeploys are automated via GitHub Actions — verified end-to-end 2026-07-28, first green run took 1m37s. `.github/workflows/deploy-main.yml` fires on every push to `main` (PR merge or direct push both trigger it) and runs `./scripts/deploy/fly-deploy.sh --redeploy-only --skip-build`. The `--redeploy-only` flag skips the 4-step bootstrap (apps/postgres/secrets/volumes create) — those need org-level permissions the app-scoped `FLY_API_TOKEN` doesn't have. Bootstrap is a one-time human-in-the-loop step; CI does redeploys forever.

Requires the repo secret `FLY_API_TOKEN`:

```bash
flyctl tokens create deploy \
  --app twilio-tool-sdk \
  --expiry 8760h \
  --name github-actions \
  | gh secret set FLY_API_TOKEN \
      --repo twilio-demos/conversation-agent-tool-sdk
```

`.github/workflows/pr-checks.yml` runs typecheck + vitest on every PR into `main`. Deploy is NOT gated on PR checks — direct pushes to `main` deploy immediately. Twilio-demos org policy requires SHA-pinned action refs, self-hosted `depot-ubuntu-24.04` runners (no GitHub-hosted runners on internal repos), and blocks `superfly/flyctl-actions` (the deploy workflow curl-installs flyctl instead). Doc-only pushes are skipped via `paths-ignore`.

Then configure the tunnel via the inspector (below).

## Deploy the mock backend (demo only)

Skip this section if you're plugging into a real CRM API — set `MOCK_CUSTOMERS_URL` in your `customer-mcps/crm/.env` to the real endpoint before you build the connector image.

For the demo, the mock is a **private** Fly app in the same Fly organization — reachable only from the connector via Fly's private DNS, never from the public internet. This mirrors an on-prem enterprise backend behind a firewall.

```bash
# 1. Render the mock's manifests.
mcp-connector deploy init --target fly-mock --name acme-prod \
  --out ./examples/mock-backend --yes

# 2. Create the Fly app (no deploy yet). Must be in the same Fly org as
#    mcp-connector-acme-prod — cross-org apps can't reach each other's
#    .internal DNS.
cd ./examples/mock-backend && fly launch --no-deploy --copy-config

# 3. Set the demo customer identity.
fly secrets set \
  DEMO_CUSTOMER_NAME=Alice \
  DEMO_CUSTOMER_SURNAME=Demo \
  DEMO_CUSTOMER_PHONE=+14155551234 \
  --app mock-customers-acme-prod

# 4. Deploy.
fly deploy --app mock-customers-acme-prod

# 5. Verify (from your laptop, over Fly's WireGuard mesh).
fly ssh console -a mock-customers-acme-prod -C "wget -qO- http://localhost:7400/healthz"
```

Then, in the connector repo before building the connector image, set the crm drop-in's URL to the private DNS name:

```env
# customer-mcps/crm/.env
MOCK_CUSTOMERS_URL=http://mock-customers-acme-prod.internal:7400
```

Rebuild the connector image (or use one that carries this env by default) and redeploy.

## Reach the inspector

The inspector stays bound to `127.0.0.1:9090` inside the Machine. Never bridge it to a public service — the Webhooks panel exposes bcrypt-protected URLs by design. Reach it via `fly proxy`:

```bash
# One terminal — leave running.
fly proxy 9090:9090 -a mcp-connector-acme-prod

# Browser.
open http://localhost:9090/
```

`fly proxy` opens a WireGuard tunnel from your laptop to the Machine's loopback. The auth surface is your flyctl session — only operators with access to the Fly org can open the tunnel.

This is a different, older mechanism than the inspector's machine-API
network access (see `docs/NETWORK-ACCESS.md`) — `INSPECTOR_BIND_ADDR = "::"` in this app's `[env]` exists solely so `fly proxy` can reach the mesh IP; it's not the same as opting into customer-network reachability, and `fly ips list` staying empty means this Fly deployment was never meant to be reachable any other way. Don't also add an API client for a Fly deployment unless you specifically want a machine caller (`/oauth/token`) reaching this Machine over its private `.internal` DNS from another app in the same org — the dashboard itself stays loopback-only either way, and `fly proxy`'s flyctl-session auth already covers reaching it.

## Configure the tunnel

On first boot the connector's Postgres is empty and the inspector shows a "Configure Tunnel" modal. Fill in:

- **Controller URL** — e.g. `https://your-controller.example.com`
- **Connector Name** — must exactly match the Tunnel Security row Name in your controller UI (case-sensitive)
- **Auth posture** — static bearer OR OAuth2 client credentials, matching the row type

Save. The inspector pill transitions `closed` → `connecting` → **`open`** (green).

## Verify

```bash
fly ssh console -a mcp-connector-acme-prod -C "mcp-connector doctor"
```

Exit 0 = all green. In the inspector, the MCP Server panel should show every MCP from your `connector.yaml` with "Ready" verdicts, and (if you deployed the mock) the crm drop-in's `get_customer` tool should return the demo Alice.

## Rotation

**Tunnel bearer / OAuth secret** — rotate in the controller UI (**Rotate Secret**). Prior value has a 24 h grace window. `fly machine restart` to force the pickup sooner.

**Master key** — rare (only if compromised). Wipe the Postgres schema, mint a new key, redeploy. Full recipe in [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md#master-key-rotation-rare--only-if-the-master-key-is-compromised).

**Full app recovery** — if the Fly app itself is destroyed (not just its Machines), CI can't rebuild (its `FLY_API_TOKEN` is app-scoped and can't create apps). Re-run `./scripts/deploy/fly-deploy.sh` locally against your Fly org — the script is idempotent. See [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md#full-app-recovery-after-fly-apps-destroy-or-accidental-deletion).

## Graduate to managed Postgres

Fly Postgres is unmanaged (you own backups and HA). For production, migrate to Neon, Supabase, RDS, or CloudSQL:

```bash
fly secrets set POSTGRES_URL="postgres://user:pass@managed-host:5432/mcp_connector" \
  --app mcp-connector-acme-prod
# Then, once the connector is happy on the new URL:
fly apps destroy mcp-connector-acme-prod-db
```

The connector's schema is re-created idempotently on the new database — the tunnel needs reconfiguration through the inspector (fresh empty DB), but no data loss beyond that.

## Footguns

Fly's defaults would violate the connector's load-bearing invariants. The scaffold-generated `fly.toml` avoids all of them; do not undo them:

- **`[[services]]` or `[http_service]` on the connector app** — publishes the inspector on `<app>.fly.dev`, leaking bcrypt-protected webhook URLs. There is no valid reason to add a services block.
- **`[[services]]` on the mock app** — same effect, plus violates the "private enterprise backend" contract that D5 pins.
- **`auto_stop_machines = true`** — Fly's request-based scale-to-zero. Kills the outbound WSS the moment the Machine sits idle (which is always, for an outbound-only workload).
- **`fly ips allocate-v4` or `-v6`** — allocates a public IP on either app. Every app in this deploy should have `fly ips list` return empty.
- **`fly scale count 2`** — the controller's dup-name guard 409s the second Machine. Multi-replica is a future workstream.
- **Cross-Fly-org deployment** — the mock's `.internal` DNS is only resolvable from apps in the same org. Split-org forces public exposure, breaking the private-only invariant.
- **Removing `INSPECTOR_BIND_ADDR = "::"` from the connector's `[env]`** — the inspector's default bind is `127.0.0.1`, which is unreachable from `fly proxy` (Fly's WireGuard tunnel connects to the Machine's mesh IP, not loopback). Without this override the inspector runs happily inside the Machine but there's no way to reach it from your laptop. Safe to keep the override because `fly ips list` is empty — the mesh is Fly-private, same trust surface as `.internal` DNS.
- **Moving `fly.toml` from repo root into a subdirectory** — Fly's build context is locked to the fly.toml's directory (no `--build-context` flag exists), and this connector's Dockerfile needs the repo root as context. Everything breaks with "Dockerfile not found" or missing-source errors.
- **Pasting the full `/mcp-tunnel` path into `--controller-url`** — the controller UI often shows the WS endpoint as `https://<controller>/mcp-tunnel`, but the connector appends that path itself when dialing. Pasting the full path leads to `wss://.../mcp-tunnel/mcp-tunnel` and silent handshake failure. Use the HTTPS root only (`https://<controller>`). `deploy init` will strip the `/mcp-tunnel` suffix with a loud warn if you paste it, but only that exact suffix — custom paths are left alone.
- **Port 9090 collision on `fly proxy`** — if you have a local dev inspector running (from `npm run start` in the connector repo), `fly proxy 9090:9090 -a <app>` fails with `bind: address already in use`. Either kill the local process (`lsof -i :9090` → `kill <PID>`) or use a different local port: `fly proxy 19090:9090 -a <app>` → `http://localhost:19090`.

## Reference

- [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) — full operator runbook (rotation recipes, recovery from destroyed apps, Postgres attach quirks, common troubleshooting).
- [`deploy/fly/fly.toml.example`](../../deploy/fly/fly.toml.example) — hand-editable reference config (the CLI generates the same shape).
- `CODE-DEPLOY` design record (internal) — D1–D5 rationale (why Fly Postgres, why entrypoint script, why 1 GB volume, why single region, why private mock).
- [`README.md`](README.md) — umbrella deploy doc, common prereqs.
