# Azure Container Apps

Run the connector as a Container App. Outbound-only.

> `mcp-connector deploy init --target aca` renders a bicep template
> with your connector name + controller URL substituted in. The
> walkthrough below covers the reasoning behind each choice.
>
> `mcp-connector deploy apply --target aca` is **not yet implemented** —
> apply the emitted bicep with `az deployment group create`. Only
> `--target fly` has a full apply verb today.

## Prereqs

- Image pushed to ACR (or another registry the Container App can pull from).
- A Container Apps environment.
- A Tunnel Security row on the controller (Tools → Connectors → Tunnel
  Security) — see the [overview](./README.md). Pick the credential shape
  that matches the row's type: `ts_<...>` bearer (Twilio Auth Token /
  API Key) or `client_id` + `client_secret` + token URL (OAuth 2.0).
- Container App secrets: `tunnel-auth-token` for the long-lived bearer,
  or `oauth-client-id` + `oauth-client-secret` for OAuth 2.0. Plus the
  YAML content if you're mounting it from a secret.

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
      CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml
      # INSPECTOR_PORT defaults to 9090 (binds 127.0.0.1 only). Required for
      # any MCP using createWebhookEndpoint — disabling it (INSPECTOR_PORT=0)
      # also disables webhook ingress.
```

For an OAuth 2.0 row swap the secret + env block:

```bash
  --secrets oauth-client-id="$OAUTH_CLIENT_ID" oauth-client-secret="$OAUTH_CLIENT_SECRET" \
  --env-vars \
      OAUTH_CLIENT_ID=secretref:oauth-client-id \
      OAUTH_CLIENT_SECRET=secretref:oauth-client-secret \
      OAUTH_TOKEN_URL=https://controller.example.com/oauth2/token \
      CONNECTOR_NAME=prod-customer \
      CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml
      # Same INSPECTOR_PORT note as above — leave on the default.
```

Then mount the YAML via an Azure File share or build it into the image.
For per-environment configs (dev/stage/prod) bake `${...}` interpolation
into a single YAML and set `CONTROLLER_URL` per app. Pick distinct
`tunnel.name` values per deployment — and remember each one needs its own
Tunnel Security row on the controller (the Name on that row must match
`CONNECTOR_NAME` here, case-sensitive).

## Inspector UI

`INSPECTOR_PORT=9090` (the default) is the right value in production. The inspector binds to `127.0.0.1` inside the container — `--ingress disabled` keeps it unreachable from outside — and the SDK ↔ connector IPC routes used by webhook-receiving MCPs depend on it. Don't set `INSPECTOR_PORT=0` unless no MCP uses `createWebhookEndpoint`.

To view the UI: `az containerapp exec --name "$APP" --resource-group "$RG" --command "/bin/sh"`, then `curl http://127.0.0.1:9090/`. For a richer view, port-forward via Container Apps' debug-console endpoint, or build a separate VPN-only debug environment.

**Do not** route public ingress to the inspector port. The Webhooks panel exposes the bcrypt-protected webhook URL with a copy button — that URL *is* the secret.

## Network access (opt-in, off by default)

`--ingress disabled` above stays the right default — this feature doesn't
change that. If you want the inspector reachable from elsewhere in your
Azure VNet (not the public internet), switch to internal ingress instead:

```bash
az containerapp ingress enable \
  --name "$APP" --resource-group "$RG" \
  --type internal --target-port 9090 --transport auto
```

That alone doesn't expose anything unauthenticated — only `POST /oauth/token`
is ever reachable non-loopback, gated by a machine caller's own
`client_id`/`client_secret`. Until an operator has added at least one API
client from the inspector's loopback session (or one already exists from
a prior boot), internal callers just get 403s. The dashboard itself never
answers non-loopback requests, under any configuration. See
`docs/NETWORK-ACCESS.md`. Still never use `--type external` for this port
— that's public internet, which this feature is not for.

## Reconnect — orchestrator vs. built-in

The connector auto-reconnects on unexpected WS close by default (`policy.reconnect.enabled: true` in `connector.yaml`). On Container Apps, two shapes work; pick one.

- **Built-in (default).** Leave `policy.reconnect.enabled: true`. The connector backs off and redials in-process; the replica stays up. Right answer with `minReplicas: 1, maxReplicas: 1` — Container Apps doesn't need to restart the container.
- **Orchestrator-managed.** Set `policy.reconnect.enabled: false` and rely on Container Apps' replica-restart policy to recycle on exit. Less common on Container Apps because there's no per-port healthcheck on the WS dial — the built-in path is usually the better fit.

Don't enable both — the built-in loop will mask replica-level failures from your monitoring.

## Logs

`stdout` flows to Log Analytics. Query:
```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "mcp-connector"
| order by TimeGenerated desc
```
