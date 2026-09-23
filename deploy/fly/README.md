# Fly.io

The connector's dial-out-only shape maps cleanly onto Fly Machines: single Firecracker VM, no load balancer, outbound TLS 443 by default, and no public IP at all. Reaching the inspector dashboard needs one extra hop on Fly — see [Reach the inspector dashboard](#reach-the-inspector-dashboard).

If you want to skip the walkthrough and copy-paste, the CLI renders both apps' manifests for you:

```bash
mcp-connector deploy init --target fly --name <customer> --yes
mcp-connector deploy init --target fly-mock --name <customer> --yes  # only for the demo mock backend
```

## Deployment shape

Two Fly apps in the same Fly organization:

```
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ mcp-connector-<CUSTOMER>     │          │ mock-customers-<CUSTOMER>    │
│  - dial-out WSS → controller │          │  - HTTP :7400                │
│  - sealed config.json on its │  ← ─ ─ ─ │  - its OWN Fly Postgres      │
│    state volume (no database)│          │    (`crm` db, empty)         │
│  - inspector 127.0.0.1:9090  │          │  - no public IP              │
└──────────────────────────────┘          └──────────────────────────────┘
     (relay + fly proxy — see below)           http://mock-customers-<CUSTOMER>.internal:7400
                                                          (Fly private DNS, IPv6, WireGuard mesh)
```

The mock app is optional — a stand-in for a customer's real CRM backend. In a real deployment, only the connector app exists; the crm drop-in points at the customer's actual API.

**The connector no longer has a Postgres app.** It used to, and the mock borrowed the `crm` database off it. The connector's config is now a sealed JSON file on its state volume, so a mock deployment has to create its own database — see the mock section below. Nothing else about this topology changed.

## Reach the inspector dashboard

`fly proxy 9090:9090 -a <app>` does **not** work for the dashboard. The tunnel establishes, then every route answers:

```
403 {"ok":false,"error":"forbidden: loopback only"}
```

The bind is not the problem — `INSPECTOR_BIND_ADDR="::"` is set, so the process accepts the connection. The request *gate* is: everything outside the four allowlisted machine-API paths (`/oauth/token`, `/v1/outbound/calls`, `/v1/memory/events`, `/v1/identity/list`) requires a **loopback** caller, and `fly proxy` arrives from the Machine's `fdaa:` mesh address.

This is a Fly-specific gap rather than a design flaw. On other platforms the documented path presents a genuine loopback origin — `ssh -L 9090:localhost:9090 <host>` makes the remote sshd dial `localhost` from the host, and `kubectl port-forward` enters the pod's network namespace. Fly has neither: `fly proxy` routes over 6PN without entering the netns, and `fly ssh` has no `-L`.

Use the wrapper — it supplies that hop, prints a URL, and cleans up after itself:

```bash
./scripts/fly-inspector.sh                # app read from deploy/fly/fly.toml
./scripts/fly-inspector.sh <app>          # or name it
./scripts/fly-inspector.sh <app> 19099    # or pin the local port
```

It starts a relay inside the Machine, opens `fly proxy` to it, **verifies the Inspector answers 200 rather than 403** before handing you the URL, and on Ctrl-C stops the proxy, kills the relay inside the Machine, and confirms it is gone. It probes for free ports on both sides, and refuses to run if the app has a public IP.

If you would rather do it by hand, the two commands are a relay
(`fly ssh console -a <app> -C "node -e \"...net.connect(9090,'127.0.0.1')...\""` listening on 9099) and `fly proxy 9099:9099 -a <app>`. Two cautions if you do: killing the local `fly ssh` does **not** reliably kill the remote relay — it is parented to hallpass and has been observed outliving its terminal by hours — and the hand-run version has no self-expiry. Check for strays with `fly ssh console -a <app> -C "ps -o args" | grep createServer`.

> **Understand what this trades away.** The relay does not authenticate — it launders the source address, so the gate sees the relay rather than you. That is exactly the confused-deputy pattern the loopback rule exists to prevent, so it is **not** equivalent to `kubectl port-forward`, which is a tunnel with no listener. While it runs, any other peer on your organization's 6PN `/64` can reach the full dashboard — including the Webhooks panel, where the URL *is* the secret, and the session-creds routes. That is why the script owns teardown and gives the relay a 60-minute self-expiry: an abandoned relay is the realistic failure, not a targeted attack.

> **API clients do not help here.** The Network Access panel opens the *machine API* — `POST /oauth/token` and the `/v1/*` routes, for scripts. The dashboard requires a loopback caller no matter how many API clients exist.

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
- **A Fly organization** with billing set up (the connector Machine alone runs ~$2–3/month idle; there is no database app to pay for unless you also deploy the optional mock backend).

## Deploy the connector

Two commands. That's it.

```bash
# 1. Generate deploy/fly/fly.toml. Sits alongside per-platform artifacts
#    for the other deploy targets (deploy/helm/, deploy/terraform/, etc.).
#    `deploy apply --target fly` always runs fly commands from the repo
#    root with `-c deploy/fly/fly.toml` so the build context (CWD) is
#    the full repo — Dockerfile paths in the fly.toml resolve to
#    connector/Dockerfile as expected.
mcp-connector deploy init --target fly --name acme-prod --yes
# Result: ./deploy/fly/fly.toml.

# 2. Deploy — creates the Fly app + master key + state volume,
#    then runs `fly deploy -c deploy/fly/fly.toml`. Idempotent — safe to
#    re-run if any step is interrupted. Foreground so you see build
#    progress live.
mcp-connector deploy apply --target fly
```

Under the hood `deploy apply` runs the four Fly operations you'd otherwise type by hand: `fly apps create`, `fly secrets set CONNECTOR_KEY_B64`, `fly volumes create state`, and finally `fly deploy`. See [`connector/src/deploy/apply.ts`](../../connector/src/deploy/apply.ts) for the exact sequence.

It was five. `fly postgres create` + `fly postgres attach --variable-name POSTGRES_URL` are gone — and with them the only step that was not idempotent (a re-run of `attach` exits non-zero with "already exists", which the wrapper had to special-case), the only step that provisioned a second billable app, and the `<app>-db` name that a second connector in the same org would have collided on.

### Push-to-deploy from `main`

Once the first bootstrap deploy above has run (locally, with a full-user Fly login), ongoing redeploys are automated via GitHub Actions — verified end-to-end 2026-07-28, first green run took 1m37s. `.github/workflows/deploy-main.yml` fires on every push to `main` (PR merge or direct push both trigger it) and runs `./scripts/deploy/fly-deploy.sh --redeploy-only --skip-build`. The `--redeploy-only` flag skips the 3-step bootstrap (apps/secrets/volumes create) — those need org-level permissions the app-scoped `FLY_API_TOKEN` doesn't have. Bootstrap is a one-time human-in-the-loop step; CI does redeploys forever.

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

# 3. Give the mock its OWN Postgres, then point it at it. MOCK_POSTGRES_URL
#    is the only env it reads at boot (plus optional PORT / LOG_LEVEL) and the
#    service REFUSES TO BOOT without it. The DEMO_CUSTOMER_* secrets that used
#    to live here are gone — the store is a real database, not in-memory
#    fixtures.
#
#    This step changed: the mock used to borrow the `crm` database off the
#    Postgres app that `deploy apply` created for the connector. The connector
#    keeps its config in a sealed file on its volume now and has no database,
#    so there is nothing to borrow.
fly postgres create --name mock-customers-acme-prod-db --region iad \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach mock-customers-acme-prod-db \
  --app mock-customers-acme-prod --database-name crm \
  --variable-name MOCK_POSTGRES_URL --yes

#    Or, against a Postgres you already have on the mesh:
# fly secrets set \
#   MOCK_POSTGRES_URL="postgres://postgres:<pw>@<pg-app>.flycast:5432/crm" \
#   --app mock-customers-acme-prod

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

## Machine API vs the dashboard

Never bridge the inspector port to a public service — the Webhooks panel exposes bcrypt-protected URLs by design. For getting a browser onto the dashboard, see [Reach the inspector dashboard](#reach-the-inspector-dashboard) above; this section is about the other half.

`INSPECTOR_BIND_ADDR = "::"` in this app's `[env]` exists so the **machine API** is reachable over the mesh: the controller calls `/oauth/token` and the `/v1/*` routes at `<app>.internal:9090`. It is not an opt-in to customer-network reachability, and `fly ips list` staying empty means this deployment was never meant to be reachable any other way. It does **not** make the dashboard reachable — a wide bind decides whether the process accepts the connection; the request gate then judges where it came from.

Don't add an API client for a Fly deployment unless you specifically want a machine caller reaching this Machine over its private `.internal` DNS from another app in the same org (see `docs/NETWORK-ACCESS.md`). The dashboard stays loopback-only either way.

## Configure the tunnel

On first boot the connector's config store is empty and the inspector shows a "Configure Tunnel" modal. Fill in:

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

**Master key** — rare (only if compromised). There is no re-seal path: `ConfigStore.open()` compares a fingerprint and refuses to start against a store sealed with a different key. So rotation means destroying the state volume, minting a new key, redeploying, and reconfiguring the tunnel. Full recipe in [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md#master-key-rotation-rare--only-if-the-master-key-is-compromised).

**Full app recovery** — if the Fly app itself is destroyed (not just its Machines), CI can't rebuild (its `FLY_API_TOKEN` is app-scoped and can't create apps). Re-run `./scripts/deploy/fly-deploy.sh` locally against your Fly org — the script is idempotent. See [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md#full-app-recovery-after-fly-apps-destroy-or-accidental-deletion).

## Back up the state volume

This section used to be "Graduate to managed Postgres" — advice on migrating the connector off unmanaged Fly Postgres to Neon / RDS / CloudSQL. It is deleted rather than rewritten: there is no database to graduate.

What replaces it is smaller but not nothing. `state/config.json` on the volume holds the sealed tunnel bearer and the registration token, so:

- **Back it up together with `CONNECTOR_KEY_B64`, or not at all.** A volume snapshot without the key decrypts to nothing, which is the point of sealing it — but it also means a snapshot alone is not a recovery plan.
- **Losing the volume is recoverable but not silent.** The operator re-runs Configure Tunnel, and the re-register collides on `name_taken` against the controller's surviving row until someone clears it. (An unknown *registration token* self-heals across a whole fleet with no human involvement; a taken *name* needs a click per connector. That asymmetry is deliberate — see the reconnect semantics in CLAUDE.md.)
- **`fly volumes` snapshots are the mechanism.** Fly takes daily snapshots of volumes by default and retains them 5 days; `fly volumes snapshots list <volume-id>` shows them.

## Footguns

Fly's defaults would violate the connector's load-bearing invariants. The scaffold-generated `fly.toml` avoids all of them; do not undo them:

- **`[[services]]` or `[http_service]` on the connector app** — publishes the inspector on `<app>.fly.dev`, leaking bcrypt-protected webhook URLs. There is no valid reason to add a services block.
- **`[[services]]` on the mock app** — same effect, plus violates the "private enterprise backend" contract that D5 pins.
- **`auto_stop_machines = true`** — Fly's request-based scale-to-zero. Kills the outbound WSS the moment the Machine sits idle (which is always, for an outbound-only workload).
- **`fly ips allocate-v4` or `-v6`** — allocates a public IP on either app. Every app in this deploy should have `fly ips list` return empty.
- **`fly scale count 2`** — the controller's dup-name guard 409s the second Machine. Multi-replica is a future workstream.
- **Cross-Fly-org deployment** — the mock's `.internal` DNS is only resolvable from apps in the same org. Split-org forces public exposure, breaking the private-only invariant.
- **Removing `INSPECTOR_BIND_ADDR = "::"` from the connector's `[env]`** — the default bind is `127.0.0.1`, which the controller cannot reach over `.internal` DNS, so the machine-API routes (`/oauth/token`, `/v1/*`) stop answering. Safe to keep because `fly ips list` is empty — the mesh is Fly-private, same trust surface as `.internal` DNS. Note this override does NOT make the dashboard reachable; that needs the relay above.
- **Moving `fly.toml` from repo root into a subdirectory** — Fly's build context is locked to the fly.toml's directory (no `--build-context` flag exists), and this connector's Dockerfile needs the repo root as context. Everything breaks with "Dockerfile not found" or missing-source errors.
- **Pasting the full `/mcp-tunnel` path into Configure Tunnel** — the controller UI often shows the WS endpoint as `https://<controller>/mcp-tunnel`, but the connector appends that path itself when dialing. Pasting the full path would lead to `wss://.../mcp-tunnel/mcp-tunnel` and silent handshake failure. Use the HTTPS root only (`https://<controller>`). The modal strips `/mcp-tunnel` and `/mcp-tunnel/tunnel` for you, case-insensitively and idempotently — but other stray paths (`/api`, a query string) are left alone, so they still break the dial. (`deploy init` used to do this stripping too; it no longer takes a controller URL at all.)
- **Local port collision on `fly proxy`** — if you have a local dev inspector running (from `npm run start` in the connector repo), a proxy onto the same local port fails with `bind: address already in use`. Either kill the local process (`lsof -i :9090` → `kill <PID>`) or pick a different LOCAL port: `fly proxy 19099:9099 -a <app>` → `http://localhost:19099`.

## Reference

- [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) — full operator runbook (rotation recipes, recovery from destroyed apps, common troubleshooting).
- [`deploy/fly/fly.toml.example`](../../deploy/fly/fly.toml.example) — hand-editable reference config (the CLI generates the same shape).
- `CODE-DEPLOY` design record (internal) — D1–D5 rationale (why entrypoint script, why 1 GB volume, why single region, why private mock). Its D1 "why Fly Postgres" is superseded by `architectural-plans/DB-TO-FILE.md`.
- [`README.md`](README.md) — umbrella deploy doc, common prereqs.
