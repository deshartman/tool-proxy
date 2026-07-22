# CODE-DEPLOY — Fly.io deployment plan

> **Goal.** Deploy the mcp-connector to Fly.io in a shape that (a) preserves every load-bearing property from [CLAUDE.md](../CLAUDE.md), (b) is customer-reproducible from a small set of `flyctl` commands, and (c) fits Fly's Machines-first execution model without fighting the platform's defaults.
>
> **Branch.** `feature/fly-deploy` — cut from `main` 2026-07-22.
>
> **Status: implemented (2026-07-23).** All five design decisions (D1–D5) resolved. S1–S5 shipped. Live Fly deploy verified: connector + Fly Postgres + state volume + inspector reachable via `fly proxy`. **EK bundle NOT deployed** — deliberately out of scope; the Fly.io deploy target proves the connector's deploy shape works, EK on Fly is its own workstream (needs Ollama sidecar + pgvector Postgres). See §"Lessons learned" for every latent bug this exercise surfaced.
>
> **Self-describing.** A fresh-context Claude should be able to read this file + [CLAUDE.md](../CLAUDE.md) + [docs/deploy/README.md](../docs/deploy/README.md) and start work. No hidden context; every subtle interaction with a load-bearing property is called out inline.

## Context — why Fly.io is a natural fit

The connector's runtime shape maps cleanly onto Fly Machines:

| Connector requirement | Fly.io native fit |
|---|---|
| Outbound-only WSS to controller, TLS 443 | Fly Machines have unrestricted egress by default; no NAT gateway config needed. |
| No inbound port for the tunnel | Skip Fly's `[http_service]` / `[[services]]` blocks entirely. Nothing binds to the shared IP. |
| Single instance per `CONNECTOR_NAME` (until multi-replica lands per [DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md) Stage G) | `min_machines_running = 1`, `auto_stop_machines = false`. One Machine, one region. |
| Inspector on `127.0.0.1:9090` (loopback trust boundary) | Reach via `fly proxy 9090:9090 -a <app>` — same UX as `kubectl port-forward` but no cluster admin needed. |
| Master key at rest (32 bytes → libsodium `secretbox`) | Fly Secrets (env-scoped) OR a mounted volume; both encrypted by Fly's control plane. |
| `db` mode's Postgres backend | Fly Postgres (unmanaged), Fly-hosted Supabase, external Neon/RDS, or a sibling Machine running `postgres:16-alpine`. |
| Multi-arch OCI image already published | Fly builds by default from a public/private registry — `image = "ghcr.io/twilio/mcp-connector:<tag>"` in fly.toml. |

**Cost frame.** A `shared-cpu-1x/512MB` Machine is ~$3/month idle. With Fly Postgres (dev tier, $0 through free allowance): ~$3–5/month all-in per connector. Cheaper than Fargate/ACA equivalents; comparable to a hand-run VM.

## Env-file inventory (what moves where on Fly)

Six `.env` (or `.env.example`) files matter for a Fly deploy. Each has a different destination — some become Fly secrets, some become bundled into a per-app image, some vanish entirely.

| File | Purpose today | Fly destination |
|---|---|---|
| `./.env` (root, `packages/connector/.env.example` is the template) | Connector core: `POSTGRES_URL`, `CONNECTOR_KEY_FILE`, optional `INSPECTOR_PORT` / `MCP_BASE_PORT`. Currently points at `localhost:5433` — dev-only. | **`mcp-connector` Fly app**. `POSTGRES_URL` → `fly secrets set` (points at Fly Postgres or external managed DB). `CONNECTOR_KEY_FILE` stays `/etc/mcp-connector/connector.key`; value comes from `CONNECTOR_KEY_B64` secret via entrypoint (D2). `INSPECTOR_PORT` stays 9090 default; do NOT surface externally. |
| `mock/customers/.env` | Demo identity — `DEMO_CUSTOMER_NAME/SURNAME/PHONE`. Only meaningful when the mock is running. | **`mock-customers` Fly app** (per D5 below). `fly secrets set DEMO_CUSTOMER_PHONE=…` for the demo phone this deployment should treat as focal. |
| `mock/customers/.env.example` | Documents `PORT` (default 7400). | Template only — the mock's fly.toml pins `internal_port = 7400` and the deployed app doesn't need `PORT` set. |
| `mcp/local/crm/.env.example` | Bridges the crm drop-in to the mock: `MOCK_CUSTOMERS_URL=http://localhost:7400`. | **`mcp-connector` Fly app**, per-MCP env. Value flips to `http://mock-customers.internal:7400` (Fly private DNS) or `https://mock-customers-<demo>.fly.dev` (public). This is "hosts" — see §"Hosts and cross-app networking". |
| `mcp/bundled/enterprise-knowledge/.env` | EK bundle: `EK_PGVECTOR_DSN`, `EK_SOURCES_YAML` (absolute local path!), `OLLAMA_URL=http://localhost:11464`, `EK_GDRIVE_SERVICE_ACCOUNT_KEY` (absolute local path!). | **Out of scope for the initial Fly deploy.** Every absolute local path in this file breaks in a container. EK needs its own Postgres + Ollama sidecar + Drive key file — that's a second deployment plan (see [embedding-sidecar.md](../docs/deploy/embedding-sidecar.md)). If the customer's connector yaml includes the EK entry, disable it before first Fly deploy or plan the sidecar concurrently. |
| `compose.env.example` | `MCP_VERSION` + `POSTGRES_PASSWORD` for `docker-compose.prod.yml`. | Compose-only. Not used on Fly. |

**Rule of thumb.** Anything with a value that varies per-deployment (URLs, secrets, demo identity) becomes `fly secrets set`. Anything structural (paths inside the container, ports the container binds to) becomes `[env]` in `fly.toml`. Secrets never end up in `fly.toml`.

**One thing your current `./.env` gets wrong for Fly.** `POSTGRES_URL=postgres://ek:ek-dev-password@localhost:5433/enterprise_knowledge` is your local Postgres from the enterprise-knowledge dev compose — it collides two databases (mcp_connector schema + EK's pgvector) on the same instance for dev convenience, but `localhost` doesn't resolve inside a Fly Machine. Deployment step 3 replaces this with the Fly Postgres URL. If you later add EK to the same Fly deployment, keep the collision (single Postgres, two schemas) since the connector's `POSTGRES_SCHEMA` isolates them cleanly.

## Load-bearing constraints (Fly-specific recap)

Every one of these comes from [CLAUDE.md](../CLAUDE.md) §"Architecturally load-bearing properties". Repeating them here because Fly's defaults would silently violate several:

- **No `[http_service]` block in `fly.toml`.** Fly's `launch` wizard adds one by default. It publishes `internal_port = 8080` on the shared IP with automatic TLS. For this connector, that would either bind nothing (no listener on 8080) or, worse, expose the inspector if someone edits `internal_port` to 9090 to "make it work". **The correct fly.toml has zero `[[services]]` and zero `[http_service]`.** The tunnel is outbound-only; the inspector is loopback-only.
- **`auto_stop_machines = false` and `min_machines_running = 1`.** Fly's default scale-to-zero would kill the WSS the moment there's no inbound traffic — and there's never any inbound traffic on this deployment, so the Machine would stop immediately after boot. This is the single biggest footgun on Fly for a dial-out workload.
- **`INSPECTOR_PORT` stays bound to `127.0.0.1`** inside the Machine (enforced in [`packages/connector/src/inspector/server.ts`](../packages/connector/src/inspector/server.ts) — 127.0.0.1 bind is source-hardened). Fly's `fly proxy` tunnels from your laptop to the Machine's loopback over a WireGuard mesh — it does NOT bridge the port to the public IP. The trust boundary stays intact.
- **`replicas: 1` per `CONNECTOR_NAME`.** The controller's dup-name guard 409s a second Machine registering with the same name. Do NOT template `count = 2` in the Fly `[[processes]]` block. Multi-replica is [DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md) Stage G work and requires controller-side dispatch changes; it is out of scope here.
- **Egress to `CONTROLLER_URL` over TLS 443.** Fly allows this by default; if the customer runs Fly's WireGuard-based egress restrictions, add the controller's hostname to their allowlist. Not applicable to standard Fly orgs.

## Design decisions

Four choices shape the fly.toml + secrets + volume story. Each has a recommendation but needs explicit sign-off before implementation — the wrong pick here bakes friction into every future deploy.

**Decisions locked (2026-07-22):**
- **D1 = (a)** Fly Postgres via `fly postgres create` — mimics the sibling `postgres:16-alpine` container from `docker-compose.prod.yml`. Not going with Neon/RDS/CloudSQL/Supabase.
- **D2 = (a)** Entrypoint script decodes `CONNECTOR_KEY_B64` → `CONNECTOR_KEY_FILE` at boot. Ships in the OCI image so Compose keeps working unchanged.
- **D3 = (b)** 1 GB Fly volume mounted at `/var/lib/mcp-connector/`.
- **D4 = (a)** Single region (`primary_region = "iad"`), `min_machines_running = 1`.
- **D5 = (a)** Separate private Fly app for the mock, connector-only reachability via `.internal` DNS. See §D5.

Ready for S1–S3b implementation. Retain the trade-off tables below as design record.

> **Note on D1 terminology.** Fly's own docs describe `fly postgres create` as "unmanaged" — it spins up a Postgres image on Fly Machines, but you own backups, HA, and upgrades. That's the "single-command Fly-hosted Postgres, roughly what docker-compose gives you today" shape. If a real customer graduates to prod, the recommendation is still to move to managed (Neon/Supabase/RDS/CloudSQL) — noted in the walkthrough as "when to graduate" but out of scope for this plan.

### D1 — Postgres backend

The connector's `db` mode (recommended default per [CLAUDE.md](../CLAUDE.md) §"Config files") needs Postgres for the sealed `controllers` row. Four options on Fly:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Fly Postgres (managed, single-node)** | `fly postgres create --name <app>-db --region <r>` | Cheapest, most integrated. One command. Fly attaches the DB URL as a Fly secret automatically. | Fly Postgres is *unmanaged* per Fly's own docs — you own backups. Single node = SPOF. Fine for dev/staging; not for prod. |
| **(b) Fly-hosted Supabase / Neon serverless** | External URL, `fly secrets set POSTGRES_URL=...` | Managed backups; connection pooling; auto-scaling. | Adds a second vendor. Egress cost (usually zero at this scale). |
| **(c) External RDS / CloudSQL** | Same shape as (b) | Aligns with a customer's existing DB posture. | Requires the customer to already have RDS/CloudSQL; if they don't, adds significant setup. |
| **(d) Sibling Fly Machine running `postgres:16-alpine`** | Two Machines in the app, private-network URL | Zero external deps; mirrors the `docker-compose.prod.yml` shape 1:1. | Customer runs their own Postgres. Not much simpler than (a) in practice. |

**Recommendation: (a) for demo/dev/POC; (b) or (c) for production.** The default `deploy/fly/` scaffold assumes (a); an "upgrade to managed Postgres" note in the walkthrough covers the graduation path. Do not template a Postgres sidecar Machine — the `depends_on: postgres` invariant that works in Compose doesn't have a clean Fly equivalent (Machine start ordering is not deterministic within an app), and the whole point of the Fly deploy is one Machine per connector.

### D2 — Master key delivery to `CONNECTOR_KEY_FILE`

The connector reads a 32-byte master key from `CONNECTOR_KEY_FILE` at boot ([`packages/connector/src/env.ts`](../packages/connector/src/env.ts) → seals the `controllers` row with libsodium `secretbox_easy`). The path is a file, not an env var. Fly Secrets are env-only. Three ways to bridge:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Entrypoint script writes secret to file** | `docker-entrypoint.sh` decodes `$CONNECTOR_KEY_B64` (base64 env) into `/etc/mcp-connector/connector.key` at boot, then execs the connector. Set `CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key`. | Zero connector code change. Standard 12-factor pattern. Works on every platform, not just Fly. | New shell file to ship (small, ~5 lines). |
| **(b) Patch connector to accept `CONNECTOR_KEY_B64`** | New env branch in [`packages/connector/src/env.ts`](../packages/connector/src/env.ts): if `CONNECTOR_KEY_B64` is set, decode it and skip the file read. `CONNECTOR_KEY_FILE` remains the primary path. | No entrypoint. One less moving part in the image. | Widens the config surface; needs a doctor check + test coverage. Boot-preflight branch in [`require-env.ts`](../packages/connector/src/boot/require-env.ts) grows a case. |
| **(c) Fly volume with key file laid down manually** | `fly volumes create key_vol`, ssh in, write the file, chmod 400. Mount at `/etc/mcp-connector/`. | Key never appears in an env var or in Fly's control plane state. | Manual step; can't be reproduced from `fly deploy` alone. Doesn't rotate without operator SSH. Kills the "one command deploy" pitch. |

**Recommendation: (a) entrypoint script.** Ships as `deploy/fly/entrypoint.sh` and gets baked into the image at Fly build time (or, cleaner: shipped as part of the OCI image's default entrypoint so it works everywhere). Rotate the key by `fly secrets set CONNECTOR_KEY_B64=<new>` + `fly deploy` — Fly restarts the Machine, entrypoint re-writes the file, connector picks up the new key. Trust boundary is unchanged from static-bearer today: the secret lives in Fly's secret store, encrypted at rest, only visible to the Machine's env.

(b) is a good second-tier option if we decide to standardize `CONNECTOR_KEY_B64` across Fly + Container Apps + any future secret-manager-as-env platform. Suggest deferring until a second platform requests it, per CLAUDE.md's "no speculative flexibility" rule.

### D3 — State volume

`.connector-state.json` carries the controller-minted `registrationToken` under `env` mode. Under `db` mode (recommended default) the token lives sealed in `controllers.registration_token_ct` — the state file is legacy scaffolding, best-effort deleted on first successful register-ack per [CLAUDE.md](../CLAUDE.md) §"One-shot env→db migration".

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) No volume** | Rely on Postgres for all persistence. Machine restart = fresh disk = fine. | Simplest fly.toml. No volume cost. | If we ever regress to needing the state file (e.g. env-mode reversion for debugging), the customer needs to add a volume later. |
| **(b) 1GB volume mounted at `/var/lib/mcp-connector/`** | Same shape as Compose. Survives Machine restart within a region. | Belt-and-braces. Cheap ($0.15/GB/month). Migration lane back to `env` mode is intact. | Fly volumes are single-region-pinned. Doesn't survive a region migration; requires `fly volumes create` per region. |

**Recommendation: (b) as the default in the scaffold.** The cost is negligible; the operational safety net matters more than the (small) fly.toml simplification. Postgres remains the source of truth; the volume is scratch/cache/legacy-lane space. If we ship (a) and a customer later needs `env` mode for a rollback, they hit a "why doesn't state persist" bug and have to add a volume — precisely the opposite of "lean and easy".

### D4 — Region strategy

Fly is opinionated about regions. Two viable postures:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Single region** | `primary_region = "iad"` (or nearest to controller), `min_machines_running = 1` in that region only. | Cheapest. Deterministic. Matches the "single connector per name" invariant. | Regional outage = connector down. Acceptable for most customers; controller retries webhooks so no data loss (see [STATUS-CALLBACK-MCP.md](Done/STATUS-CALLBACK-MCP.md), controller-side buffering). |
| **(b) Multi-region standby** | Machines in `iad` + `fra`; only one boots at a time via Fly's process groups. | Regional failover. | Requires Stage G (multi-replica) to be safe; today's dup-name guard 409s the second region. Do not ship pre-Stage-G. |

**Recommendation: (a).** Multi-region is a post-Stage-G concern per [DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md). Document how to fail over manually today (`fly regions set fra`, `fly machine restart`) — the RTO is single-digit minutes and the failure mode is "no data loss, just downtime".

### D5 — Mock customer service deployment

The `mock/customers/` service is a Node HTTP server on port 7400 exposing `/customers`, `/appointments`, `/availability`, `/orders/:id`, `/healthz`. In dev the crm drop-in dials it at `http://localhost:7400`. It's gitignored dev scaffolding per [CLAUDE.md](../CLAUDE.md) §"Dev-only scaffolding" — production customers don't run this; they plug the crm MCP at their real CRM API.

**Load-bearing invariant for the demo shape (2026-07-22).** The mock stands in for a customer's enterprise backend, so it MUST have the same reachability posture as one: **private, no public IP, reachable only from the connector app**. Anything less would model a different world than the one we're demoing. In Fly terms this means:
- **No `[[services]]` block. No `[http_service]` block.** The mock never terminates public TLS.
- **No public IPv4/IPv6 allocation.** `fly ips list -a mock-customers-<DEMO>` MUST be empty. `fly ips allocate-*` on the mock app is a red flag.
- **Reachable only via Fly private DNS (`<app>.internal`).** WireGuard mesh between apps in the same Fly org, IPv6 only, not resolvable outside Fly's control plane.
- **Same Fly org as the connector.** Cross-org apps can't reach each other's `.internal` names.

This is the "behind an enterprise firewall" analogue. It IS a hard requirement — any option that violates it (see (b) and (d) below) is rejected.

For a live Fly demo, the mock has to go somewhere. Four options, evaluated against the private-only invariant above:

| Option | Shape | Verdict |
|---|---|---|
| **(a) Separate Fly app `mock-customers-<demo>`, no public IP, `.internal` DNS only** | Own fly.toml, own image, own Machine. Same Fly org as the connector. Reachable only at `http://mock-customers-<demo>.internal:7400`. | **Chosen.** Matches real-world posture (customer's backend is a separate deploy inside their private network). Independent restart / logs / secrets. Different blast radius. |
| **(b) Multi-process single Fly app** | One image, two entrypoints wired via Fly `[processes]`. | **Rejected.** Bundles mock into the connector image — the mock is no longer a "separate enterprise system", it's a process inside the customer connector. Doesn't model the world we're demoing. |
| **(c) Skip the mock; crm points at customer's real API** | Real deployment shape. `MOCK_CUSTOMERS_URL` → customer's actual CRM endpoint. | **Target end state for real customers, not the demo.** Nothing to build in this plan — the crm drop-in already talks HTTP to whatever URL it's given. |
| **(d) Localhost sidecar in the connector Machine** | Mock running alongside connector, dialed via `127.0.0.1:7400`. | **Rejected.** Same as (b) — bundles the mock into the connector's process space; kills the separation-of-concerns pedagogy. Also violates the invariant literally: `localhost` isn't "private between apps", it's "same app". |

**Decision: (a) is the demo shape. (c) is what real customers actually run.** When Twilio ships this to a real customer, only the connector app deploys; the mock app goes away and (c) takes over. Zero connector-side code change to graduate.

**Implementation shape for (a).**
- Second Fly app: `mock-customers-<demo>`, in the same Fly org as the connector.
- Its own image built from `mock/customers/` (~10 lines Dockerfile — Node 22, `npm ci --omit=dev`, `tsx server.ts`). Since `mock/customers/` is gitignored, this image is dev/demo-only; do not publish alongside the connector image.
- Reachable from the connector via Fly private DNS: `http://mock-customers.internal:7400` (see §"Hosts and cross-app networking").
- Demo customer identity (`DEMO_CUSTOMER_PHONE` etc.) via `fly secrets set` on the mock app.
- No `[[services]]` block either — the mock is only accessed via `.internal`. Optionally expose publicly (`fly ips allocate-v4 --shared`) if the demo needs to hit it from a browser, but the connector doesn't need public exposure.
- No volume, no Postgres — data is in-memory. Restart = fresh fixtures.

**Open sub-questions:**
- **D5.1** — Should the mock app's fly.toml + Dockerfile ship in this repo (`mock/customers/fly.toml`, gitignored like the rest of `mock/`) or in a separate demo-infra repo? Recommend: in this repo, gitignored, next to `mock/customers/server.ts` — same trust posture as the mock itself.
- **D5.2** — Does the mock app need its own `/livez` / `/readyz`? It already has `/healthz` returning `ok` — good enough for a Fly `[[http_service.checks]]` block if we decide to expose it publicly.
- **D5.3** — Do we auto-provision the mock in the connector's `deploy scaffold --target fly`, or is it a separate `mcp-connector deploy scaffold --target fly-mock`? Recommend: separate target — keeps the connector deploy self-contained and lets a real customer skip the mock entirely.

## Hosts and cross-app networking

The mock is private per the D5 invariant. The connector reaches it over Fly's private DNS — the same posture an on-prem connector would have reaching a `crm.internal.acme.corp` service behind the customer's firewall.

**The wire:**

```
mcp-connector-<CUSTOMER>            mock-customers-<DEMO>
  crm drop-in ──HTTP──> http://mock-customers-<DEMO>.internal:7400
                        │
                        └─ Fly private DNS (AAAA only, IPv6, WireGuard mesh)
```

**The `crm/.env` (baked into the connector image):**

```env
MOCK_CUSTOMERS_URL=http://mock-customers-<DEMO>.internal:7400
```

**Fly `.internal` DNS — the properties that make this equivalent to a firewalled enterprise service:**
- **Not resolvable from the public internet.** `dig mock-customers-<demo>.internal` from anywhere outside Fly's WireGuard mesh returns NXDOMAIN. There is no public NS record for `.internal`.
- **Same-Fly-org only.** Only apps in the connector's Fly organization can resolve or reach the mock. This is the analogue of "same VPC" or "same corporate network" — apps outside the org can't even see the name.
- **IPv6-only, WireGuard-encrypted end-to-end.** Fly resolves `.internal` to AAAA records over its private 6PN mesh. Node's `http` client handles this natively; no `NODE_OPTIONS` tweaking needed.
- **No TLS termination.** Plain HTTP is fine — the mesh itself is encrypted at the transport layer. Attaching a TLS cert to a `.internal` name is not possible (no public CA path) and unnecessary.
- **Names, not app IDs.** `<app-name>.internal` — so `mock-customers-des.internal` if the app is named `mock-customers-des`. Fly does NOT prepend the org name.

**Enterprise-firewall analogue.** Rows in "how a real customer would model this":

| Fly primitive | Enterprise equivalent |
|---|---|
| `.internal` DNS in same Fly org | Corporate internal DNS zone (`*.corp`, `*.internal`) |
| WireGuard 6PN mesh | Private VPC / VLAN behind the firewall |
| No `[[services]]` on the mock | No public DNS record; no port-forward at the perimeter firewall |
| No `fly ips allocate-*` | No public IP assignment; service unreachable from the internet |
| Same-Fly-org restriction | Same-VPC or peered-network restriction |

**Env resolution chain for `MOCK_CUSTOMERS_URL`.** Per [CLAUDE.md](../CLAUDE.md) §"Per-entry env precedence (subtle)", two ways to set it:
- **(i) Bake into image.** Ship `mcp/local/crm/.env` with the `.internal` URL. Deterministic for the demo; matches the fixed-hostname convention.
- **(ii) Controller-pushed.** Leave `.env` empty; the controller pushes the URL on register-ack via `creds-request` — matches the "creds live on the controller" pitch and is the graduation path for real customers whose CRM URL is credential-adjacent (`https://<tenant>.salesforce.com`).

**Recommendation for the demo: (i).** The mock's Fly hostname is deterministic and never rotates.

**If you want stricter than "same Fly org can reach it" — e.g. only the connector app** — that's beyond what `.internal` DNS enforces (any app in the org can resolve any other app's `.internal` name). Two ways to get there if it ever matters:
- **Shared-bearer auth on the mock.** Mock refuses requests without `Authorization: Bearer <token>`; token is a Fly secret on both apps. ~10 lines in `mock/customers/server.ts`. Recommended as future work only if the demo Fly org grows beyond "just these two apps".
- **Fly Machines Flycast with restricted policies.** More elaborate; overkill for a two-app demo. Not planned.

## Reaching the inspector on Fly

The inspector stays bound to `127.0.0.1:9090` inside the connector Machine — the loopback invariant from [CLAUDE.md](../CLAUDE.md) §"Architecturally load-bearing properties" never bends. On Fly, the operator reaches it via **`fly proxy`**, which opens a WireGuard-tunneled local port on the operator's laptop that forwards to the Machine's loopback.

```bash
# One-time flyctl auth (if not already authed to your Fly org):
fly auth login

# Open a local port that tunnels to the connector Machine's 127.0.0.1:9090:
fly proxy 9090:9090 -a mcp-connector-<CUSTOMER>

# Then, from a browser on the same laptop:
open http://localhost:9090/
```

**Why this preserves the loopback trust boundary.**
- `fly proxy` opens a WireGuard tunnel from your laptop through Fly's control plane to the Machine's private 6PN mesh IP.
- Inside the Machine, the tunnel emerges on `127.0.0.1:9090` — the same address the inspector already binds to (source-hardened in [`packages/connector/src/inspector/server.ts`](../packages/connector/src/inspector/server.ts)).
- Nothing is exposed on the public internet. The Machine still has no public IP (`fly ips list -a mcp-connector-<CUSTOMER>` MUST be empty), no `[[services]]` block, no `[http_service]` block.
- Only operators with authenticated flyctl sessions in the app's Fly org can open the tunnel. The auth surface is Fly's — same one gating `fly deploy` and `fly secrets`.
- The Webhooks panel's bcrypt-protected URLs continue to be safe to expose in the UI, because the UI is only reachable through your authenticated `fly proxy` session.

**Common gotchas.**
- **Port 9090 already bound locally?** Remap the *local* side: `fly proxy 19090:9090 -a mcp-connector-<CUSTOMER>` → open http://localhost:19090/.
- **SSE streams (Frames / MCP Status panels).** Work fine — `fly proxy` is a plain TCP forwarder; server-sent events pass through untouched.
- **Multiple connector apps?** One `fly proxy` per app, each on a different local port.
- **Wi-Fi flap kills the tunnel.** `fly proxy` restarts cleanly; the inspector re-establishes its SSE streams automatically once the tunnel is back.
- **flyctl not authed / wrong org.** `fly apps list` sanity-checks the session; the target app must appear in the list.

**What NOT to do to reach the inspector.**
- Do NOT add `[[services]]` with `internal_port = 9090` — publishes the inspector on `<app>.fly.dev`, leaking every bcrypt-protected webhook URL. Same footgun as bridging the inspector to a public LB on Fargate/GKE.
- Do NOT `fly ips allocate-*` on the connector app. `fly ips list` MUST remain empty.
- Do NOT tunnel via Cloudflare / ngrok / a second overlay network. Fly's own mesh already gives you this; extra hops just add moving parts and a second auth surface to lock down.
- `fly ssh console -a mcp-connector-<CUSTOMER>` gets you a shell inside the Machine, but you'd then have to `curl 127.0.0.1:9090/api/...` blind — useful for `mcp-connector doctor` runs, not for the UI.

## Recommended concrete shape

Assuming D1(a) + D2(a) + D3(b) + D4(a) — the demo/dev-ready path. The customer graduates D1 to managed Postgres when they hit prod.

### `deploy/fly/fly.toml.example`

```toml
# mcp-connector — Fly.io deployment
# Copy to fly.toml, edit `app`, and `fly deploy`.
# Do NOT add [[services]] or [http_service] — this connector is outbound-only.

app = "mcp-connector-<CUSTOMER>"
primary_region = "iad"

[build]
  image = "ghcr.io/twilio/mcp-connector:0.1.0"

[env]
  CONNECTOR_CREDS_SOURCE = "db"
  CONNECTOR_KEY_FILE = "/etc/mcp-connector/connector.key"
  CONNECTOR_CONFIG = "/etc/mcp-connector/config.yaml"
  CONNECTOR_STATE_PATH = "/var/lib/mcp-connector/.connector-state.json"
  INSPECTOR_PORT = "9090"
  # POSTGRES_URL, CONNECTOR_KEY_B64: injected via `fly secrets set`.

[[mounts]]
  source = "state"
  destination = "/var/lib/mcp-connector"

# No [[services]] — the connector dials out. Nothing to expose.
# Reach the inspector with: fly proxy 9090:9090 -a mcp-connector-<CUSTOMER>

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"

[deploy]
  # Force a rolling restart so key/URL rotation via `fly secrets set` takes effect.
  strategy = "immediate"

# Fly's scale-to-zero would kill the WSS. Force one Machine to stay running.
# When multi-replica lands (per DEPLOY-ARCHITECTURE.md Stage G), this becomes >= 2.
[[metrics]]
  port = 9091
  path = "/metrics"
```

The `[[metrics]]` block is speculative — points at the planned `/livez` + `/readyz` health server ([DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md) Friction #4, Stage A). Drop it until Stage A ships and the port is finalized.

### `deploy/fly/entrypoint.sh`

```sh
#!/bin/sh
set -eu

# Fly Secrets are env-only. The connector reads the master key from a file.
# Decode CONNECTOR_KEY_B64 → CONNECTOR_KEY_FILE at boot; then exec.
if [ -n "${CONNECTOR_KEY_B64:-}" ]; then
  mkdir -p /etc/mcp-connector
  echo "$CONNECTOR_KEY_B64" | base64 -d > /etc/mcp-connector/connector.key
  chmod 400 /etc/mcp-connector/connector.key
fi

exec mcp-connector start "$@"
```

Ship in the OCI image as `/usr/local/bin/mcp-connector-entrypoint.sh`, wire it as the Dockerfile `ENTRYPOINT`. Works on Fly (via `CONNECTOR_KEY_B64`) AND on Compose (which mounts the file directly and leaves `CONNECTOR_KEY_B64` unset — the `-n` guard is a no-op there). One entrypoint, both platforms.

### `mock/customers/fly.toml.example` (per D5(a))

Shipped gitignored alongside the mock's `server.ts`, since the whole `mock/` tree is dev-only per [CLAUDE.md](../CLAUDE.md) §"Dev-only scaffolding".

```toml
# mock-customers — Fly.io deployment (demo only)
# Simulates a customer's real CRM API. Reachable ONLY over Fly private DNS.

app = "mock-customers-<DEMO>"
primary_region = "iad"

[build]
  # Built from mock/customers/ — see mock/customers/Dockerfile.
  dockerfile = "Dockerfile"

[env]
  PORT = "7400"
  NODE_ENV = "production"
  # DEMO_CUSTOMER_* via `fly secrets set` — see mock/customers/.env.example

# DO NOT add [[services]] or [http_service]. The mock stands in for an
# enterprise backend and must be private — reachable ONLY over Fly's
# WireGuard mesh at http://mock-customers-<DEMO>.internal:7400, from the
# connector app in the same Fly org. `fly ips list` on this app MUST be
# empty. See architectural-plans/CODE-DEPLOY.md §D5 for the invariant.

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "256mb"  # mock is tiny — in-memory data, no deps.

[deploy]
  strategy = "immediate"
```

A minimal `mock/customers/Dockerfile` (also gitignored):

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7400
CMD ["npx", "tsx", "server.ts"]
```

### `deploy/fly/README.md` — operator walkthrough

Two Fly apps deployed in order — mock first (so its `.internal` DNS is live when the connector's crm drop-in dials it), then the connector.

**A. Deploy the mock (once per demo customer):**

1. `cd mock/customers && fly launch --no-deploy --copy-config` (uses `fly.toml.example` if you copied it)
2. `fly secrets set DEMO_CUSTOMER_PHONE=+14155551234 DEMO_CUSTOMER_NAME=Alice DEMO_CUSTOMER_SURNAME=Demo`
3. `fly deploy`
4. Confirm: `fly ssh console -a mock-customers-<DEMO> -C "wget -qO- http://localhost:7400/healthz"` → `ok`

**B. Deploy the connector:**

5. `cd deploy/fly && fly launch --no-deploy --copy-config`
6. `fly postgres create --name <app>-db --region iad` → attaches `DATABASE_URL` as a secret automatically
7. `fly secrets set POSTGRES_URL=$DATABASE_URL CONNECTOR_KEY_B64=$(head -c 32 /dev/urandom | base64)`
8. `fly volumes create state --region iad --size 1`
9. Edit `mcp/local/crm/.env` in your repo before build: `MOCK_CUSTOMERS_URL=http://mock-customers-<DEMO>.internal:7400`
10. `fly deploy`
11. `fly proxy 9090:9090` → open http://localhost:9090/ → Configure Tunnel → paste `CONTROLLER_URL` + `CONNECTOR_NAME` + bearer

Verification: `fly ssh console -a mcp-connector-<CUSTOMER> -C "mcp-connector doctor"` returns exit 0; the inspector shows the crm drop-in as "Ready" and issuing a test `get_customer` returns the mocked Alice.

## Step-by-step implementation (if approved)

Ordered by dependency; each step is a discrete PR-sized chunk.

| Step | Status | Change | Files |
|---|---|---|---|
| **S1** | ✅ done | Ship the entrypoint script and wire it as the Dockerfile `ENTRYPOINT`. Backwards-compatible: no-op when `CONNECTOR_KEY_B64` is unset. | [`packages/connector/Dockerfile`](../packages/connector/Dockerfile), [`packages/connector/entrypoint.sh`](../packages/connector/entrypoint.sh), [`tests/deploy/entrypoint.test.ts`](../packages/connector/tests/deploy/entrypoint.test.ts) |
| **S2** | ✅ done | `deploy/fly/fly.toml.example` + `deploy/fly/README.md` (hand-authored operator runbook). | [`deploy/fly/`](../deploy/fly/) |
| **S3** | ✅ done | `--target fly` in scaffold CLI, template constants + tests. | [`src/deploy/scaffold.ts`](../packages/connector/src/deploy/scaffold.ts), [`src/deploy/templates.ts`](../packages/connector/src/deploy/templates.ts), [`tests/deploy/scaffold.test.ts`](../packages/connector/tests/deploy/scaffold.test.ts) |
| **S3b** | ✅ done | `--target fly-mock` + `mock/customers/fly.toml` + `mock/customers/Dockerfile` (D5 shape). `targetNeedsControllerUrl()` helper skips CONTROLLER_URL prompt. | Same as S3 + `flyMockToml` / `flyMockDockerfile` template constants. |
| **S4** | ✅ done | [`docs/deploy/fly-io.md`](../docs/deploy/fly-io.md) customer walkthrough + [`docs/deploy/README.md`](../docs/deploy/README.md) index update. | `docs/deploy/*` |
| **S5** | ✅ done | [`CLAUDE.md`](../CLAUDE.md) §"Deployment scaffolding" + §"Dev-only scaffolding" + §"Distribution" (entrypoint note) refresh. | `CLAUDE.md` |
| **S6** | 📋 queued | Scaffold `--target fly` output should land at repo root (not `./deploy/fly/`) — Fly's build context is locked to fly.toml's directory, and the Dockerfile needs repo root. Change `DEFAULT_OUT.fly` in `scaffold.ts` OR document the required `mv fly.toml <repo-root>/` step in `secrets-hint.sh`. Update tests. | [`src/deploy/scaffold.ts`](../packages/connector/src/deploy/scaffold.ts), [`tests/deploy/scaffold.test.ts`](../packages/connector/tests/deploy/scaffold.test.ts) |
| **S7** | ✅ done | `INSPECTOR_BIND_ADDR` env var. Default `127.0.0.1` unchanged; Fly's `[env]` overrides to `::` because `fly proxy` tunnels to the mesh IP not loopback. WARN log fires when bind widens. | [`src/inspector/server.ts`](../packages/connector/src/inspector/server.ts), scaffold `flyToml` template |
| **S8** | 📋 queued | Fold the four Phase-B latent-bug fixes into the scaffold's template constants and per-cloud guides — the fly.toml template should already include the `INSPECTOR_BIND_ADDR = "::"` line; the `secrets-hint.sh` should mention the `--variable-name POSTGRES_URL` flag prominently; the walkthrough should tell operators to redirect `fly deploy` output to a file. Currently these live in the hand-authored `deploy/fly/*` files but not in the generated scaffold. | [`src/deploy/templates.ts`](../packages/connector/src/deploy/templates.ts), [`docs/deploy/fly-io.md`](../docs/deploy/fly-io.md) |

**Estimated remaining.** S6 + S8 ≈ 1–2 hours of scaffold updates + doc alignment. S7 is coded and tested but not yet committed (branch-local).

## Verification

Manual, following the "primary verification is interactive via the inspector UI" rule in [CLAUDE.md](../CLAUDE.md) §"Common commands":

1. `fly deploy` — Machine boots, entrypoint writes key, connector starts.
2. `fly logs` — expect `authToken: "set (len=…)"` OR `authToken: "oauth2 (clientId=…)"` after auth resolution.
3. `fly proxy 9090:9090 &` — inspector reachable at `http://localhost:9090/`.
4. **Configure Tunnel modal** (empty-DB boot) — paste controller URL + connector name + bearer. Submit.
5. Inspector transitions closed → reconnecting → connecting → **open** (green pill).
6. `fly ssh console -C "mcp-connector doctor"` — exit 0, all green.
7. **MCP Server panel** — Type 1 drop-ins from the image (sample, if any) appear with "Ready" verdicts.

## What we do NOT do (and why)

Enumerated because these are the Fly footguns a well-meaning customer will try:

- **`[http_service]` publishing port 9090.** Would leak the bcrypt-protected webhook URLs from the inspector's Webhooks panel. Trust-boundary violation. Documented in the walkthrough with a red-box warning.
- **`auto_stop_machines = true`.** Kills the WSS. There's no inbound traffic to keep the Machine "warm" under Fly's request-based auto-start logic.
- **Multi-region `[[processes]]` with `count = 2`.** Second Machine 409s at register. Waits on Stage G.
- **Fly's public `fly-app.fly.dev` hostname on either app.** No use case — the connector dials out; the mock is a private enterprise-backend analogue. `fly ips list` MUST be empty on both apps. Any operator instinct to "just expose it to test" leaks the trust boundary (inspector's bcrypt webhook URLs on the connector; unauthenticated fake-data endpoints on the mock).
- **`[[services]]` / `[http_service]` on the mock.** Same reason — the mock is behind-the-firewall by contract. Adding it would model a different world.
- **Cross-Fly-org deployment.** The connector and mock MUST live in the same Fly org for `.internal` DNS to resolve. Split-org is technically supported but requires public exposure, which violates the mock's private-only invariant.
- **Fly Postgres backup as the DR strategy.** Fly Postgres is unmanaged; if the customer graduates to prod, D1 needs to shift to managed. Documented as "when to graduate".

## Open design questions

All primary decisions (D1–D5 + Meta) resolved on 2026-07-22 — see the "Decisions locked" block under §"Design decisions". Sub-questions still parked:

- **D5.1** — Ship the mock's `fly.toml.example` + `Dockerfile` in this repo (gitignored, next to `mock/customers/server.ts`) or in a separate demo-infra repo? Leaning: in-repo, gitignored, same trust posture as the mock itself. Confirm before S3b.
- **D5.2** — Does the mock app add a `[[http_service.checks]]` block against `/healthz`? Only relevant if we ever expose it publicly (we don't). Skip.
- **D5.3** — `--target fly` and `--target fly-mock` as separate scaffold verbs (chosen), or a combined `--target fly-demo` that emits both? Separate is already in the S3/S3b breakdown; revisit if `--target fly-demo` turns out to be what customers actually type.
- **Future — Postgres graduation.** When a real customer moves to prod, does the walkthrough recommend Neon, Supabase, RDS, or CloudSQL by default? Deferred until we have a first prod customer.
- **Future — mock stricter than same-org.** Shared-bearer auth on the mock (~10 lines in `mock/customers/server.ts`) if the demo Fly org grows beyond just these two apps. Not planned; noted in §"Hosts and cross-app networking".

## Lessons learned (2026-07-22 → 2026-07-23)

The core deploy plan (D1–D5) needed zero revision. What we didn't expect: nine latent bugs surfaced only by actually building and running the OCI image. Every one traces back to the same pattern — **"the local `npm run build` from the working tree resolves files or dependencies from the surrounding tree; the isolated Docker/Fly build context does not"**. Same class as [ENV-TO-DB.md](ENV-TO-DB.md)'s post-Step-12 discoveries: real-run pass surfaces stuff analysis can't. All fixed on `feature/fly-deploy`.

### Phase A — local `docker build` + `docker run` (before Fly)

**Bug A1 — `postbuild.mjs` reads from repo root, Dockerfile didn't COPY it.** The postbuild script (`packages/connector/scripts/postbuild.mjs`) copies `.env.example` + `connector.yaml.example` from `<repoRoot>/` into `packages/connector/` so the npm tarball ships them. The Dockerfile COPY'd `packages/connector/` and `tsconfig.base.json` but NOT the two repo-root template files. `npm run build` failed with `ENOENT: /repo/.env.example`. **Fix:** `COPY .env.example connector.yaml.example ./` in the node-build stage before `RUN npm run build`.

**Bug A2 — npm workspace hoisting isn't uniform.** `dotenv@^17.4.2` failed to hoist to `<repoRoot>/node_modules` (npm chose to nest it under `packages/connector/node_modules/dotenv` for version-conflict isolation). Every other prod dep hoisted fine. Dockerfile's runtime stage only COPY'd `/repo/node_modules`, so `dotenv` disappeared from the image. Connector crashed at startup with `Cannot find package 'dotenv'`. **Fix:** also `COPY --from=node-build /repo/packages/connector/node_modules ./packages/connector/node_modules` in the runtime stage. Diagnostic recipe (for any workspace-nested dep): `docker run --rm --entrypoint /bin/sh <img> -c 'for dep in $(node -e "console.log(Object.keys(require(\"/app/packages/connector/package.json\").dependencies).join(\" \"))"); do [ -d "/app/node_modules/$dep" ] && echo root || echo nested; done'`.

**Bug A3 — `CONNECTOR_KEY_FILE` had no `ENV` default in the Dockerfile.** The entrypoint writes to `${CONNECTOR_KEY_FILE:-/etc/mcp-connector/connector.key}` — the shell-level default resolves inside entrypoint.sh but doesn't propagate to the exec'd `node` process's env. Result: entrypoint wrote the file at the default path; the connector's env-loader failed with `CONNECTOR_KEY_FILE is required` because that var was unset from Node's POV. **Fix:** `ENV CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key` in the Dockerfile, symmetric with the existing `CONNECTOR_CONFIG` default. Rule: any path the entrypoint uses as a default MUST also be an `ENV` in the Dockerfile.

**Test coverage added:** [`packages/connector/tests/deploy/entrypoint.test.ts`](../packages/connector/tests/deploy/entrypoint.test.ts) — 4 cases pinning both branches (env-set decode + env-unset no-op).

### Phase B — real Fly deploy

**Bug B1 — `fly.toml` must live at repo root, not `deploy/fly/`.** Fly's `[build] dockerfile` path is resolved relative to the fly.toml's directory. Even with `fly deploy --config deploy/fly/fly.toml --dockerfile packages/connector/Dockerfile` from the repo root, Fly interpreted the Dockerfile path as `deploy/fly/packages/connector/Dockerfile` (doesn't exist). And Fly has no `--build-context` flag — build context is locked to the fly.toml's directory. Our Dockerfile COPYs `package.json`, `packages/connector/`, `mcp/`, `bundles/` — every one of those requires the repo root as context. **Workaround for this deploy:** moved `fly.toml` to the repo root. **Followup S6 (queued below):** scaffold template needs to emit `fly.toml` at repo root, not `deploy/fly/`.

**Bug B2 — `mcp_servers: []` was over-constrained by `.min(1)`.** Yaml schema in [`packages/connector/src/config.ts`](../packages/connector/src/config.ts) required at least one `mcp_servers` entry — but empty is a legitimate posture when the customer runs ONLY drop-ins (auto-discovered from `MCP_DROPIN_DIR`) or controller-pushed Type 2 MCPs (from `mcp-config-snapshot`). Forced our first-attempt yaml to include a placeholder Type 3 entry that couldn't actually spawn. **Fix:** `.min(1)` → `.default(() => [])`. Also accepts a yaml with no `mcp_servers` key at all. Pinned by [`tests/config/empty-mcp-servers.test.ts`](../packages/connector/tests/config/empty-mcp-servers.test.ts).

**Bug B3 — `fly postgres attach` requires `--variable-name POSTGRES_URL` explicitly.** Fly's default env var name is `DATABASE_URL`, which the connector doesn't recognize. Missing this flag → boot fails with `POSTGRES_URL is required` even though Postgres is attached. **Fix:** documented in [`deploy/fly/README.md`](../../deploy/fly/README.md) + [`docs/deploy/fly-io.md`](../../docs/deploy/fly-io.md) + scaffold's `secrets-hint.sh` — but the flag is easy to miss on first reading. Consider making `POSTGRES_URL` fallback to `DATABASE_URL` in `env.ts` as a future ergonomics fix.

**Bug B4 — inspector's `127.0.0.1` bind is unreachable via `fly proxy`.** Fly's `fly proxy` tunnels through the WireGuard mesh to the Machine's private mesh IP (fdaa:...), NOT to the Machine's `127.0.0.1`. Loopback-only bind → nothing listens on the mesh interface → HTTP 000, connection refused. Every other platform's port-forward mechanism (`kubectl port-forward`, `aws ecs execute-command`, `az containerapp exec`) establishes "inside-container" reach *first*, then hits `127.0.0.1`. Fly is the outlier. **Fix:** new env-driven `INSPECTOR_BIND_ADDR` in [`packages/connector/src/inspector/server.ts`](../packages/connector/src/inspector/server.ts). Default stays `127.0.0.1` (docker-compose, laptop dev, K8s/Fargate/ACA all preserved unchanged). Fly's `[env]` overrides to `::`. WARN log fires when the bind isn't loopback so a misconfigured non-Fly deploy is loud in operator logs. Trust posture preserved: `fly ips list` MUST remain empty (invariant already in the plan), so the mesh IS the private network — same trust surface as `.internal` DNS.

**Bug B5 — Fly's Depot builder silently buffers output when stdout is piped.** `fly deploy 2>&1 | tail` blocks entirely until the process ends. Nothing to look at during a 3-min build; if it hangs, indistinguishable from "still running". **Fix (dev-side, not code):** always redirect to a real file — `nohup fly deploy > /tmp/fly-deploy.log 2>&1 &` — then `tail -f` the log to see live builder output. Worth documenting in the operator runbook.

**Bug B6 — `.dockerignore` was missing every dev-only cache we've added since it was written.** `.venv/` (961 MB), `.ollama-cache/` (262 MB), `graphify-out/`, `.playwright-mcp/`, `.local-backups/`, Python caches (`__pycache__`, `.pytest_cache`, `.egg-info`, `.ruff_cache`, `.mypy_cache`), and `mock/` (dev-only per D5). Build context ballooned to 400+ MB before `.venv` content even started transferring. First deploy on a fresh Fly builder took 5+ minutes just to send the context. **Fix:** slimmed [`.dockerignore`](../.dockerignore) — the missing patterns are documented at the additions. Rule: whenever `.gitignore` grows to exclude a new dev artifact directory, `.dockerignore` should grow with it.

### Meta-lesson

**Every one of these nine bugs was invisible to local `npm test`, `npm run build`, and even a targeted `docker build` from the working tree.** The classes that trip an isolated build:

- **Path assumptions**: postbuild scripts, docker COPYs, and default-path env vars must be consistent across the build's isolated context.
- **npm workspace edges**: hoisting isn't guaranteed; nested workspace `node_modules` need explicit COPY.
- **Platform-specific reach mechanics**: `fly proxy` ≠ `kubectl port-forward` ≠ `aws ecs execute-command`. A loopback bind that works on 3/4 platforms may be unreachable on the 4th.
- **Silent transport buffering**: piping remote-builder stdout hides progress; use direct file redirection.
- **Ignore-file drift**: `.dockerignore` decays as the repo adds new dev caches — audit it whenever `.gitignore` changes.

Recommend adding a CI step that does `docker build` + `docker run <img> doctor` (or the closest equivalent). Build-only CI catches Bug A1 but not A2, A3, B2, B4. A real image run catches everything up to but not including B1/B3/B5/B6, which are Fly-specific and need a real Fly deploy to catch. The lessons are portable — the controller dev doing the same local check will hit some of these too (particularly A1, A2, A3, B5, B6).

## Cross-references

- [CLAUDE.md](../CLAUDE.md) — Architecturally load-bearing properties; config-file shape; auth postures. Every subtle "why" here traces back.
- [DEPLOY-ARCHITECTURE.md](DEPLOY-ARCHITECTURE.md) — Cross-cloud deployment plan; Fly.io is listed as green-light there, this doc drills in.
- [docs/deploy/README.md](../docs/deploy/README.md) — Umbrella deploy doc; S4 adds a Fly.io row.
- [docker-compose.prod.yml](../docker-compose.prod.yml) — Reference shape for single-VM `db`-mode deploy. The Fly.toml shape is a translation of this compose file into Fly primitives.
- [packages/connector/src/deploy/scaffold.ts](../packages/connector/src/deploy/scaffold.ts) — Existing scaffold engine; S3 extends with `--target fly`.
- [packages/connector/src/deploy/templates.ts](../packages/connector/src/deploy/templates.ts) — Template strings for existing targets. S3 adds `flyToml` + `flyEntrypoint` + `flyReadme` constants.
- [packages/connector/Dockerfile](../packages/connector/Dockerfile) — S1 touches `ENTRYPOINT`.
- [.claude/plans/](../.claude/plans/) — Once implementation starts, move this doc to `.claude/plans/CODE-DEPLOY.md` per the plans-directory memory (self-contained, `Status: completed YYYY-MM-DD` when done).
