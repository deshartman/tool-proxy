# Deploying the MCP connector

The connector is a single Node.js process. It dials out over WSS to a
controller and serves an inspector UI on `:9090`. No inbound ports are
required for the tunnel itself.

## Shortest path

The Fly.io target has the tightest end-to-end story — two CLI commands
create the app, attach Postgres, mint the master key, provision state,
and deploy:

```bash
mcp-connector deploy init  --target fly \
  --name prod-us-east-1 --app-name my-connector \
  --controller-url https://your-controller.example.com --yes
mcp-connector deploy apply --target fly
```

For docker-compose (single VM):

```bash
mcp-connector deploy init --target compose \
  --name prod-us-east-1 \
  --controller-url https://your-controller.example.com \
  --out ./deploy/compose
cd deploy/compose
docker compose up -d
docker compose exec connector mcp-connector doctor
```

For Kubernetes and other public clouds, `deploy init` emits `fargate`,
`gke`, and `aca` targets. `deploy apply` is Fly-only today; for the
others, apply the emitted manifests with `aws` / `kubectl` / `az`.
Terraform / Helm users can point straight at the modules under
[`deploy/terraform/`](../../deploy/terraform/) and [`deploy/helm/`](../../deploy/helm/)
instead — no scaffold step needed.

## Prereqs (every cloud)

1. Build and push the OCI image:
   ```bash
   IMAGE=your-registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh
   ```
   (Multi-arch: `linux/amd64,linux/arm64`.)
2. Pick a unique `tunnel.name` for this connector deployment.
3. Mint the per-tunnel handshake credential on the controller. Open the controller UI, go to **Tools → Connectors → Tunnel Security → New Tunnel Security**, enter the same Name as step 2 (case-sensitive), pick a security type, paste your Twilio AccountSid + (AuthToken or ApiKey), Save. The controller verifies against Twilio's API and returns one of:
   - **`ts_<...>`** (Twilio Auth Token / API Key types) — long-lived bearer. Store as `TUNNEL_AUTH_TOKEN` in your cloud's secret manager.
   - **`client_id` + `client_secret` + token URL** (OAuth 2.0 type) — short-lived JWT minted by the connector at each connect. Store all three as `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `OAUTH_TOKEN_URL`. Best when you want a config-flip migration to `oauth.twilio.com` once Twilio takes over as the issuer.

The connector dials the controller with `Authorization: Bearer <bearer>` plus `X-Connector-Name: <name>`; the controller looks up the row by `(tenant_id, name)` and verifies the bearer (bcrypt-compare for `ts_<...>`, JWT signature + claims for OAuth2). Both headers are required — missing or mismatched = HTTP 401 at the WS upgrade.

Rotate via the row's **Rotate Secret** (long-lived) or by issuing a new client secret (OAuth2); previous credentials stay valid for 24h so the connector can pick up the new value on its next restart without coordinated downtime.

> **API Key posture caveat.** The Twilio API Key tunnel-security row authenticates the WS handshake fine, but it does NOT auto-fill `TWILIO_AUTH_TOKEN` for the bundled `apis` MCP — the bundle is AuthToken-only at the Twilio-client layer. If you're running the Twilio bundle, either also include an AuthToken on the row, or run a sibling Auth Token row whose creds the controller can auto-fill from. See [MCP-PROTOCOL.md §"Twilio-bundled auto-fill"](../MCP-PROTOCOL.md).

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

- [AWS Fargate](./aws-fargate.md) — also see [`deploy/terraform/aws-fargate/`](../../deploy/terraform/aws-fargate/README.md).
- [Azure Container Apps](./azure-container-apps.md)
- [GCP GKE](./gcp-gke.md) — also see [`deploy/helm/mcp-connector/`](../../deploy/helm/mcp-connector/README.md).
- [Fly.io](./fly-io.md) — also see [`deploy/fly/`](../../deploy/fly/README.md). Cheapest path for demos; ships private-mock deploy alongside the connector.

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
