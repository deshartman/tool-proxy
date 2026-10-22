# Deploying the MCP connector

The connector is a single Node.js process. It dials out over WSS to a
controller and serves an inspector UI on `:9090`. No inbound ports are
required for the tunnel itself.

## Shortest path

The Fly.io target has the tightest end-to-end story — two CLI commands
create the app, mint the master key, provision state, and deploy:

```bash
tool-proxy deploy init  --target fly \
  --name prod-us-east-1 --app-name my-connector --yes
tool-proxy deploy apply --target fly
```

For docker-compose (single VM):

```bash
# Use the file that ships in the repo — no scaffold step needed.
cd deploy/compose
mkdir -p secrets
head -c 32 /dev/urandom > secrets/connector.key && chmod 400 secrets/connector.key
printf 'mcp_servers: []\n' > connector.yaml
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec connector node dist/index.js doctor
```

**`-f docker-compose.prod.yml` is required, not optional.** That directory ships
`docker-compose.prod.yml` and `docker-compose.dev.yml` (the latter is the crm
demo's mock-backend Postgres, unrelated to the connector) and **no**
`docker-compose.yml`, so a bare `docker compose up -d` there fails with
`no configuration file provided: not found`. Measured on a fresh clone.

`tool-proxy deploy init --target compose --out <dir>` is the alternative: it
writes a `docker-compose.yml`, so bare `docker compose` commands work in **that**
directory. Don't point it at `deploy/compose` — you would end up with two compose
files whose differences are invisible at the command line.

`node dist/index.js doctor`, **not** `tool-proxy doctor`: the image's
WORKDIR is `/app/connector` and the workspace bin link at
`/app/node_modules/.bin` is not on `PATH`, so the bare name fails with
`not found`.

For Kubernetes and other public clouds, `deploy init` emits `fargate`,
and `aca` targets. Kubernetes is served by the Helm chart instead of a
`deploy init` target. `deploy apply` is Fly-only today; for the
others, apply the emitted manifests with `aws` / `kubectl` / `az`.
Terraform / Helm users can point straight at the modules under
[`deploy/terraform/`](../deploy/terraform/) and [`deploy/helm/`](../deploy/helm/)
instead — no scaffold step needed.

## Prereqs (every cloud)

**The connector needs exactly one thing from your cloud's secret manager: a
32-byte master key.** Everything else — controller URL, connector name, auth
posture, the tunnel credential itself — is typed into the inspector's Configure
Tunnel modal after the container is running, and sealed into the state volume
with that key. Four env vars (`CONNECTOR_NAME`, `CONTROLLER_URL`,
`TUNNEL_AUTH_TOKEN`, `OAUTH_CLIENT_*`) used to live here and were retired by
ENV-TO-DB; `POSTGRES_URL` was retired by DB-TO-FILE. If a manifest you are
carrying still sets any of them, it predates those changes.

1. Build and push the OCI image:
   ```bash
   IMAGE=your-registry/tool-proxy:0.1.0 PUSH=1 ./scripts/build-image.sh
   ```
   (Multi-arch: `linux/amd64,linux/arm64`.)
2. Mint a 32-byte master key into your cloud's secret manager, as a file mount
   (`CONNECTOR_KEY_FILE`) or an env value (`CONNECTOR_KEY_B64`, which the
   entrypoint decodes at 0400 and unsets before dropping privileges). Generate
   it with a command — `head -c 32 /dev/urandom | base64` — never by hand and
   never into a ticket or chat.
3. Pick a unique name for this connector deployment. You will type it into
   Configure Tunnel; it is not an env var.
4. Mint the per-tunnel handshake credential on the controller. Open the controller UI, go to **Tools → Connectors → Tunnel Security → New Tunnel Security**, enter the same Name as step 3 (case-sensitive), pick a security type, paste your Twilio AccountSid + (AuthToken or ApiKey), Save. The controller verifies against Twilio's API and returns one of:
   - **`ts_<...>`** (Twilio Auth Token / API Key types) — long-lived bearer. Paste it into Configure Tunnel's static-bearer field.
   - **`client_id` + `client_secret` + token URL** (OAuth 2.0 type) — short-lived JWT minted by the connector at each connect. Paste all three into Configure Tunnel's OAuth2 fields. Best when you want a config-flip migration to `oauth.twilio.com` once Twilio takes over as the issuer.
5. Reach the inspector as a **loopback** caller and fill in the modal. The
   dashboard refuses every non-loopback caller, permanently, so this is a
   required step and not a convenience — a deployment cannot complete
   first-connect without it.

   | Platform | Command |
   |---|---|
   | Fly | `./scripts/fly-inspector.sh <app>` — **not** bare `fly proxy`, which 403s |
   | Kubernetes | `kubectl port-forward deploy/<name> 9090:9090` |
   | Remote VM | `ssh -L 9090:127.0.0.1:9090 <host>` |
   | ECS / Fargate | ECS Exec, then an in-task relay (see the aws-ec2 module's README) |
   | ACA | `az containerapp exec` |
   | compose, locally | **no host port is published** — `docker compose exec connector wget -qO- http://127.0.0.1:9090/` to smoke-test, or run the connector directly rather than containerised |

   What makes a forward qualify: it must *originate inside* the box. `ssh -L`
   works because the remote sshd dials localhost itself; `kubectl port-forward`
   enters the pod's netns. A forward that merely reaches the host's published
   port does not — measured: the mapping is refused, and a widened
   `INSPECTOR_BIND_ADDR` answers `403 forbidden: loopback only` because the gate
   judges the caller's source address.

The connector dials the controller with `Authorization: Bearer <bearer>` plus `X-Connector-Name: <name>`; the controller looks up the row by `(tenant_id, name)` and verifies the bearer (bcrypt-compare for `ts_<...>`, JWT signature + claims for OAuth2). Both headers are required — missing or mismatched = HTTP 401 at the WS upgrade.

Rotate via the row's **Rotate Secret** (long-lived) or by issuing a new client secret (OAuth2); previous credentials stay valid for 24h so the connector can pick up the new value on its next restart without coordinated downtime.

> **API Key posture caveat.** The Twilio API Key tunnel-security row authenticates the WS handshake fine, but it does NOT auto-fill `TWILIO_AUTH_TOKEN` for the bundled `apis` MCP — the bundle is AuthToken-only at the Twilio-client layer. If you're running the Twilio bundle, either also include an AuthToken on the row, or run a sibling Auth Token row whose creds the controller can auto-fill from. See [MCP-PROTOCOL.md §"Twilio-bundled auto-fill"](../docs/MCP-PROTOCOL.md).

## Webhook ingress

If any of your MCPs need to receive inbound HTTPS POSTs (Twilio `statusCallback`, message-status updates, recording / fax / video status, etc.), the connector consumes them over the existing tunnel — **not** by opening a port. The public URL lives on the controller; the controller dispatches `/api/webhook/<connectorId>/<token>` on the same port that already serves `/mcp-tunnel` and `/crelay`. So the connector deployment shape doesn't change for webhook ingress:

- **No load balancer in front of the connector.** Same rule that already applies to the tunnel — connector dials out, nothing reaches it inbound.
- **No new DNS, no new TLS cert.** All webhook traffic terminates on the controller's existing public hostname.
- **Inspector port stays 127.0.0.1-only.** The inspector exposes the bcrypt-protected webhook URL with a copy button (operators paste it into Twilio configs). Bridging `INSPECTOR_PORT` to a public LB would leak the secret — don't.

When the WSS is down (deploy, restart, blip), the controller returns 503 to the upstream and Twilio retries per its documented retry policy. The connector does not buffer.

## Cloud-specific guides

Each walkthrough covers footguns, reconnect strategy, and how to reach the
inspector — for the manifest shapes themselves, prefer `deploy init`
(and `deploy apply` for `--target fly`) or the IaC modules above.

- [AWS Fargate](./terraform/README.md) — Terraform module reference at [`terraform/aws-fargate/`](./terraform/aws-fargate/README.md).
- [Azure Container Apps](./aca/README.md)
- [GCP GKE](./helm/README.md) — Helm chart reference at [`helm/tool-proxy/`](./helm/tool-proxy/README.md).
- [Fly.io](./fly/README.md) — operator runbook at [`fly/OPERATOR-RUNBOOK.md`](./fly/OPERATOR-RUNBOOK.md). Cheapest path for demos; ships private-mock deploy alongside the connector.

## Your cloud isn't listed?

Any container runtime that doesn't kill long-lived outbound TCP works. The
two things to verify:

1. **WSS stays open.** No connection idle-timeout under ~15 minutes (the
   connector heartbeats every 1.5s by default, but some load balancers count
   only data-plane frames, not pings).
2. **Egress to your controller URL.** TLS 443 outbound. Most clouds allow
   this by default; if you have an egress allowlist, add the controller's
   hostname.

The connector itself has no requirements beyond Node 22 and outbound TLS.
