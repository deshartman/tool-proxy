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
  --cpu 1.0 --memory 2Gi \
  --ingress disabled \
  --secrets connector-key-b64="$(head -c 32 /dev/urandom | base64)" \
  --env-vars \
      CONNECTOR_KEY_B64=secretref:connector-key-b64 \
      CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key \
      CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml
      # INSPECTOR_PORT defaults to 9090 (binds 127.0.0.1 only). Required for
      # any MCP using createWebhookEndpoint — disabling it (INSPECTOR_PORT=0)
      # also disables webhook ingress.
```

**That is the whole credential surface: one secret.** `TUNNEL_AUTH_TOKEN`,
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL`, `CONNECTOR_NAME`
and `CONTROLLER_URL` all used to be set here, and there was a second variant of
this command for the OAuth2 posture. Both are gone: **the auth posture is chosen
in the inspector's Configure Tunnel modal**, and the values are sealed into the
state volume under the master key above. There is no longer an env-var form of
tunnel identity, so there is nothing here that differs between postures.

In production, source the key from Key Vault rather than inline — inline lands
it in your shell history and in the ACA revision:

```bash
az keyvault secret set --vault-name <kv> --name connector-key-b64 \
  --value "$(head -c 32 /dev/urandom | base64)"
# then reference it: --secrets connector-key-b64=keyvaultref:<url>,identityref:system
```

`--cpu 1.0 --memory 2Gi` is not padding. The measured floor is 493 MB for the
connector plus the four bundled MCPs, because each Type 1 child is three
processes (a `tsx` wrapper node, the real node, and a resident esbuild service).
A 0.5Gi app cannot boot the shipped image, and the symptom is the fourth child
dying at its readiness probe with no output — which reads as a broken MCP rather
than an undersized app. ACA only accepts fixed cpu:memory pairings; 1.0 pairs
with 2Gi.

## Persist the state volume — this is mandatory

`state/config.json` on `/var/lib/mcp-connector` holds the sealed tunnel bearer
and the registration token the controller issued. On ACA's default ephemeral
storage the connector loses its identity on every revision restart: it asks for
Configure Tunnel again, and the re-register collides on `name_taken` against the
controller's surviving row. That error is **sticky** — auto-reconnect is
suppressed and a human must click Reconnect. Unattended restart is impossible
without a real volume.

```bash
az storage share-rm create --storage-account <sa> --name mcp-connector-state --quota 1
az containerapp env storage set --name "$ENV" --resource-group "$RG" \
  --storage-name mcp-connector-state --azure-file-account-name <sa> \
  --azure-file-account-key <key> --azure-file-share-name mcp-connector-state \
  --access-mode ReadWrite
```

Then attach it to the app. `az containerapp create` cannot express a volume
mount, so this step needs the YAML/bicep form — which is what
`mcp-connector deploy init --target aca` emits, already wired up:

```bash
mcp-connector deploy init --target aca --name prod-customer \
  --out ./deploy/aca
az deployment group create --resource-group "$RG" \
  --template-file ./deploy/aca/containerapp.bicep \
  --parameters environmentId=<managed-env-id>
```

**Do not mount anything at `/etc/mcp-connector`.** The entrypoint decodes
`CONNECTOR_KEY_B64` and writes the key file there; a read-only or shadowing
mount breaks boot.

## Configure the tunnel

Nothing above set a controller URL or a connector name, because there are no env
vars for them. Once the app is running, reach the inspector as a **loopback**
caller and fill in Configure Tunnel:

```bash
az containerapp exec --name "$APP" --resource-group "$RG" \
  --command "node dist/index.js doctor"
```

`az containerapp exec` enters the container, so the connector sees a genuine
loopback caller. Every dashboard route refuses anything else, permanently and
with no opt-in — so this hop is not a convenience: a fresh deployment cannot
complete first-connect without it.

The connector name you type must match the Name on the controller's Tunnel
Security row exactly (case-sensitive). A mismatch surfaces only as HTTP 401 at
the WS upgrade; nothing local detects it beforehand.

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
