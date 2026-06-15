# AWS Fargate

Run the connector as an ECS Fargate task. Outbound TLS only, no public ALB
needed for the tunnel itself.

## Prereqs

- Image pushed to ECR (or any registry your task role can pull from).
- ECS cluster + Fargate-compatible task execution role.
- A Tunnel Security row created on the controller (Tools → Connectors →
  Tunnel Security) — see the [overview](./README.md). The Name is what
  you set as `CONNECTOR_NAME` below; the credential the controller mints
  is what you store in Secrets Manager.
- A Secrets Manager secret holding *one* of:
  - `TUNNEL_AUTH_TOKEN=ts_<...>` (Twilio Auth Token / API Key row), or
  - `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_TOKEN_URL`
    (OAuth 2.0 row).
- The `connector.yaml` stored as another Secrets Manager secret (or
  parameter store entry, S3 object, etc.).

## Footgun

**Do not put an ALB in front of this.** The connector is the *client* of a
WSS connection — there's nothing inbound to load-balance for the tunnel.
Putting it behind an ALB confuses people into expecting bidirectional WS
support and burns 60s idle timeouts on idle connections. Save the ALB only
for exposing the inspector UI (separate concern, see below).

## Recommended task definition

```jsonc
{
  "family": "mcp-connector",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [{
    "name": "connector",
    "image": "<account>.dkr.ecr.<region>.amazonaws.com/mcp-connector:0.1.0",
    "essential": true,
    "secrets": [
      // Pick the one matching your Tunnel Security row's type:
      { "name": "TUNNEL_AUTH_TOKEN", "valueFrom": "arn:aws:secretsmanager:...:secret:tunnel-token" }
      // — or, for an OAuth 2.0 row:
      // { "name": "OAUTH_CLIENT_ID",     "valueFrom": "arn:...:secret:oauth-id" },
      // { "name": "OAUTH_CLIENT_SECRET", "valueFrom": "arn:...:secret:oauth-secret" }
    ],
    "environment": [
      { "name": "CONNECTOR_CONFIG", "value": "/etc/mcp-connector/config.yaml" },
      { "name": "CONNECTOR_NAME",   "value": "prod-customer" },
      // For OAuth 2.0, add: { "name": "OAUTH_TOKEN_URL", "value": "https://controller.example.com/oauth2/token" }
      // INSPECTOR_PORT defaults to 9090 and binds to 127.0.0.1 only — keep
      // it on. The bundled twilio MCP (and any MCP using createWebhookEndpoint)
      // requires the inspector loopback for SDK ↔ connector IPC. Setting
      // INSPECTOR_PORT=0 disables both the operator UI AND webhook ingress.
      { "name": "INSPECTOR_PORT",   "value": "9090" }
    ],
    "mountPoints": [
      { "containerPath": "/etc/mcp-connector", "sourceVolume": "config" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/ecs/mcp-connector", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "connector" }
    }
  }],
  "volumes": [
    { "name": "config", "host": {} }
  ]
}
```

Mount the YAML at `/etc/mcp-connector/config.yaml`. For a Secrets Manager
secret, use a small init container or sidecar that writes the secret into
the shared volume; or build a derived image with the YAML baked in and use
`${TUNNEL_AUTH_TOKEN}` / `${CONNECTOR_NAME}` interpolation at runtime.

`CONNECTOR_NAME` must match the Name on the controller's Tunnel Security
row exactly (case-sensitive) — that's the lookup key the controller uses
to find the row and bcrypt-compare the bearer.

## Inspector UI

`INSPECTOR_PORT=9090` (the default) is the right value in production. The inspector binds to `127.0.0.1` only inside the container — nothing reaches it from the network — and the SDK ↔ connector IPC routes used by webhook-receiving MCPs depend on it. Don't disable it (`INSPECTOR_PORT=0`) unless you've confirmed no MCP in this deployment uses `createWebhookEndpoint`.

To view the UI from outside the container:
- Use ECS Exec to port-forward: `aws ecs execute-command … --command "node -e 'require(\"http\").createServer((req,res)=>require(\"http\").request({host:\"127.0.0.1\",port:9090,…}).pipe(res)).listen(8080)'"` — or simpler, run a one-off task from your bastion that proxies 8080→127.0.0.1:9090
- Or build a separate `inspector-only` task in a private subnet with a VPN.

**Do not** put the inspector port behind a public LB. The Webhooks panel exposes the bcrypt-protected webhook URL with a copy button — that URL *is* the secret.

## Logs

`stdout` only. CloudWatch Logs is the default. The connector logs every
frame at startup-time verbosity; for production set `policy.log_tool_args:
none` in the YAML.
