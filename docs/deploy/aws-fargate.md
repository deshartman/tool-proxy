# AWS Fargate

Run the connector as an ECS Fargate task. Outbound TLS only, no public ALB
needed for the tunnel itself.

## Prereqs

- Image pushed to ECR (or any registry your task role can pull from).
- ECS cluster + Fargate-compatible task execution role.
- A Secrets Manager secret holding `TUNNEL_AUTH_TOKEN`.
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
      { "name": "TUNNEL_AUTH_TOKEN", "valueFrom": "arn:aws:secretsmanager:...:secret:tunnel-token" }
    ],
    "environment": [
      { "name": "CONNECTOR_CONFIG", "value": "/etc/mcp-connector/config.yaml" },
      { "name": "INSPECTOR_PORT",  "value": "0" }
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
`${TUNNEL_AUTH_TOKEN}` interpolation at runtime.

## Inspector UI

Keep `INSPECTOR_PORT=0` in production. To debug a single task:
- Run a one-off task with `INSPECTOR_PORT=9090` and a public IP, or
- Use ECS Exec to port-forward, or
- Build a separate `inspector-only` task in a private subnet with a VPN.

## Logs

`stdout` only. CloudWatch Logs is the default. The connector logs every
frame at startup-time verbosity; for production set `policy.log_tool_args:
none` in the YAML.
