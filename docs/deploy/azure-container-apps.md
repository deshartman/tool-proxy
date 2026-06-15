# Azure Container Apps

Run the connector as a Container App. Outbound-only.

## Prereqs

- Image pushed to ACR (or another registry the Container App can pull from).
- A Container Apps environment.
- A Tunnel Security row on the controller (Tools → Connectors → Tunnel
  Security) — gives you a `ts_<...>` bearer. See the [overview](./README.md).
- Two Container App secrets: `tunnel-auth-token` (the `ts_<...>` value)
  and (if mounting from a secret) the YAML content.

## Footgun

**Don't use Azure App Service.** App Service does support WebSockets, but
it terminates idle WS connections aggressively (the public docs say "WebSockets
are kept alive by traffic"; in practice we've seen 4–5 minute teardowns even
with heartbeats). Container Apps with `minReplicas: 1, maxReplicas: 1` keeps
the same instance running.

Also: don't enable scale-to-zero. The connector must hold the WSS open. Set
`minReplicas: 1` and disable HTTP-driven scaling rules.

## Recommended deploy

```bash
RG=mcp-connector-rg
ENV=mcp-connector-env
APP=mcp-connector
IMAGE=<acr>.azurecr.io/mcp-connector:0.1.0

az containerapp create \
  --name "$APP" \
  --resource-group "$RG" \
  --environment "$ENV" \
  --image "$IMAGE" \
  --min-replicas 1 \
  --max-replicas 1 \
  --ingress disabled \
  --secrets tunnel-auth-token="$TUNNEL_AUTH_TOKEN" \
  --env-vars \
      TUNNEL_AUTH_TOKEN=secretref:tunnel-auth-token \
      CONNECTOR_NAME=prod-customer \
      CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml \
      INSPECTOR_PORT=0
```

Then mount the YAML via an Azure File share or build it into the image.
For per-environment configs (dev/stage/prod) bake `${...}` interpolation
into a single YAML and set `CONTROLLER_URL` per app. Pick distinct
`tunnel.name` values per deployment — and remember each one needs its own
Tunnel Security row on the controller (the Name on that row must match
`CONNECTOR_NAME` here, case-sensitive).

## Inspector UI

Keep `INSPECTOR_PORT=0` in production. To debug, set `--ingress internal`
and `INSPECTOR_PORT=9090`, then port-forward through `az containerapp exec`.

## Logs

`stdout` flows to Log Analytics. Query:
```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "mcp-connector"
| order by TimeGenerated desc
```
