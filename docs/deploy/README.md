# Deploying the MCP connector

The connector is a single Node.js process. It dials out over WSS to a
controller and serves an inspector UI on `:9090`. No inbound ports are
required for the tunnel itself.

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

## Cloud-specific guides

- [AWS Fargate](./aws-fargate.md)
- [Azure Container Apps](./azure-container-apps.md)
- [GCP GKE](./gcp-gke.md)

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
