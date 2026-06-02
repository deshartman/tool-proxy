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
2. Pre-provision a `connector_id` in your controller's UI.
3. Mint a `TUNNEL_AUTH_TOKEN` and store it in your cloud's secret manager.

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
