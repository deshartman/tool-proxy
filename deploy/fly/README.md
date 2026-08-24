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
│  - Fly Postgres attached     │  ← ─ ─ ─ │  - `crm` db on that same     │
│    (`mcp_connector` db)      │          │    Postgres app, empty       │
│  - inspector 127.0.0.1:9090  │          │  - no public IP              │
└──────────────────────────────┘          └──────────────────────────────┘
        (fly proxy 9090:9090)                 http://mock-customers-<CUSTOMER>.internal:7400
                                                          (Fly private DNS, IPv6, WireGuard mesh)
```

The mock app is optional — a stand-in for a customer's real CRM backend. In a real deployment, only the connector app exists; the crm drop-in points at the customer's actual API.

## Reach the inspector dashboard

`fly proxy 9090:9090 -a <app>` does **not** work for the dashboard. The tunnel establishes, then every route answers:

```
403 {"ok":false,"error":"forbidden: loopback only"}
```

The bind is not the problem — `INSPECTOR_BIND_ADDR="::"` is set, so the process accepts the connection. The request *gate* is: everything outside the four allowlisted machine-API paths (`/oauth/token`, `/v1/outbound/calls`, `/v1/memory/events`, `/v1/identity/list`) requires a **loopback** caller, and `fly proxy` arrives from the Machine's `fdaa:` mesh address.

This is a Fly-specific gap rather than a design flaw. On other platforms the documented path presents a genuine loopback origin — `ssh -L 9090:localhost:9090 <host>` makes the remote sshd dial `localhost` from the host, and `kubectl port-forward` enters the pod's network namespace. Fly has neither: `fly proxy` routes over 6PN without entering the netns, and `fly ssh` has no `-L`.

The workaround is to supply the missing loopback hop yourself. Terminal 1 — a relay inside the container, so the inspector's client really is `127.0.0.1`:

```bash
fly ssh console -a <app> -C "node -e \"const net=require('net');net.createServer(c=>{const u=net.connect(9090,'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>{});u.on('error',()=>{})}).listen(9099,'::',()=>console.log('relay up'))\""
```

Terminal 2:

```bash
fly proxy 9099:9099 -a <app>
```

Then open <http://localhost:9099>. The relay lives only as long as terminal 1; closing it removes the listener.

> **Understand what this trades away.** The relay does not authenticate — it launders the source address, so the gate sees the relay rather than you. That is exactly the confused-deputy pattern the loopback rule exists to prevent, so it is **not** equivalent to `kubectl port-forward`, which is a tunnel with no listener. While the relay runs, any other peer on your organization's 6PN `/64` can reach the full dashboard — including the Webhooks panel, where the URL *is* the secret, and the session-creds routes. Start it deliberately, keep the window short, and close terminal 1 when you are done.

Two cleaner destinations, neither built yet: restore an authenticated admin session (removed in `7c8d8ad` on the reasoning that remote reach is an infra concern — recoverable from history), or surface a read-only inspector view from the controller over the existing WSS tunnel, which needs no inbound port and no gate change at all.

## Verify state persistence after a deploy

```bash
./scripts/verify-state-volume.sh            # defaults to twilio-tool-sdk
./scripts/verify-state-volume.sh <app>
```

A volume mounted at `/var/lib/mcp-connector` shadows the image directory, discarding the Dockerfile's `mkdir` + `chown` — Fly mounts it `root:root 0755`. `connector/entrypoint.sh` re-provisions the directories before dropping privileges; this script proves it worked on the box you actually deployed, by running `saveState`'s exact sequence as the real `mcp` uid.

Worth running after any deploy that touches the entrypoint, the Dockerfile, or the `[[mounts]]` block, because **the failure it catches is lazy**: `saveState` runs on the first memory write, not at boot, so a broken deploy reports healthy and fails later under real traffic. The script includes a control write against the still-root-owned volume root — without it, a pass would also be produced by a container accidentally running everything as root.

## Machine sizing

`[[vm]] memory` in `fly.toml` is **1 GB**, not Fly's 512 MB default, and that is load-bearing.

Each Type 1 MCP is expensive because `tsx` spawns **three** processes per drop-in — a wrapper `node`, the real `node`, and a resident esbuild service. The shipped image bundles four demo MCPs (`agentic-memory`, `crm`, `salesforce`, `sample`). Measured with `free -m`, totals rather than per-process RSS (summing RSS double-counts shared pages):

| machine | children up | used | available |
|---|---|---|---|
| 512 MB (459 usable) | 3 of 4 | 412 MB | 30 MB |
| 1 GB (962 usable) | **4 of 4** | 493 MB | 336 MB |

The marginal cost of the fourth child is ~81 MB. Note 493 > 459: the full set does not fit a 512 MB machine at all, so this is not a headroom preference.

On a 512 MB machine (459 MB usable, and **no swap**) the fourth child cannot allocate. It stalls before reaching the code that binds its port or logs its first line, so the readiness probe kills it at 15s and you get exactly one clue:

```
MCP child "sample" did not become ready on port 7103 within 15000ms
```

**That message misleads here.** It reads like a slow or broken MCP, and the natural response — raising `MCP_READINESS_TIMEOUT_MS` — does nothing, because the memory is absent rather than late. A larger timeout only moves the SIGTERM. Run `fly ssh console -a <app> -C "free -m"` first: if `available` is near zero, size the machine up.

Trimming the bundle is the other lever — drop demo MCPs from the Dockerfile's `COPY` lines and the remainder fit in less.

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

# 3. Point the mock at Postgres. This is the only env it reads at boot (plus
#    optional PORT / LOG_LEVEL) and the service REFUSES TO BOOT without it.
#    The DEMO_CUSTOMER_* secrets that used to live here are gone — the store
#    is a real database now, not in-memory fixtures.
#
#    Note this is the SAME Fly Postgres app the connector uses, but a
#    different database on it: the connector owns `mcp_connector`, the mock
#    owns `crm`. Create the database first if it doesn't exist.
fly secrets set \
  MOCK_POSTGRES_URL="postgres://postgres:<pw>@mcp-connector-acme-prod-db.flycast:5432/crm" \
  --app mock-customers-acme-prod

# 4. Deploy.
fly deploy --app mock-customers-acme-prod

# 5. Verify (from your laptop, over Fly's WireGuard mesh).
fly ssh console -a mock-customers-acme-prod -C "wget -qO- http://localhost:7400/healthz"
```

**The database is empty after deploy.** There are no seeded customers,
orders, or appointments — insert whatever the demo needs via
`POST /customers`. The app is private-only, so drive it from inside the
mesh:

```bash
fly ssh console -a mock-customers-acme-prod -C "wget -qO- \
  --header='Content-Type: application/json' \
  --post-data='{\"name\":\"Dana\",\"surname\":\"Demo\",\"phone\":\"+15551239999\"}' \
  http://localhost:7400/customers"
```

`interactions[]` on that body is the orders list and can only be supplied at
create time — `customers.phone` is `UNIQUE`, so adding orders to an existing
customer means a direct insert into the `interactions` table. See
[`../../examples/demos/crm/README.md`](../../examples/demos/crm/README.md)
for the full body shape and the lookup gotchas.

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
