# mcp-connector Terraform module — AWS Fargate

Deploys a single-replica Fargate service running the mcp-connector.

## Prerequisites (out of scope for this module)

- ECS cluster (`cluster_arn`)
- Task role + execution role
- Subnets with outbound TLS 443 egress
- Security group (no inbound rules needed — connector dials out)
- A Tunnel Security row minted on the controller UI; the `ts_<...>` bearer
  gets stored in Secrets Manager after `terraform apply` (see below).

## Usage

```hcl
module "connector" {
  source = "github.com/twilio/mcp-shim//deploy/terraform/aws-fargate?ref=main"

  connector_name     = "prod-us-east-1"
  controller_url     = "https://controller.example.com"
  region             = "us-east-1"
  cluster_arn        = aws_ecs_cluster.main.arn
  task_role_arn      = aws_iam_role.connector_task.arn
  execution_role_arn = aws_iam_role.connector_exec.arn
  subnet_ids         = module.vpc.private_subnets
  security_group_id  = aws_security_group.connector_egress.id
}

# After `terraform apply`, populate the secret out-of-band:
#
#   aws secretsmanager put-secret-value \
#     --secret-id $(terraform output -raw tunnel_auth_token_arn) \
#     --secret-string "ts_<controller-minted-value>"
```

## Why the secret value isn't managed here

Passing the bearer through Terraform would land it in `tfstate` — which is
often stored in S3 with looser permissions than Secrets Manager itself. The
`aws_secretsmanager_secret` resource creates the *slot*; you populate it
via `put-secret-value` from your credential pipeline (Vault, 1Password
service accounts, whatever). The connector reads the current value at task
start, so rotation is a `put-secret-value` + `aws ecs update-service --force-new-deployment`.

## Db mode

Db mode (the recommended default) requires a Postgres instance and a
`CONNECTOR_KEY_FILE` secret. This module doesn't provision Postgres — pair
with `aws_db_instance` or `aws_rds_cluster` in the caller module. The
connector's inspector Tunnel modal handles the row seeding on first boot.

## Network access (opt-in, off by default)

`security_group_id` is caller-supplied, so this module has no inbound rules
of its own — the connector dials out and needs none. `assign_public_ip`
stays `false` unconditionally; this feature is for reachability *within*
the customer's VPC, never from the public internet.

If you want the inspector's port 9090 reachable from elsewhere in your VPC
(the operator UI, or the machine API's `/oauth/token` + outbound-calls
route once that ships), add an inbound rule to the security group you pass
in — scoped to the CIDR/security-group of whatever internal caller needs
it, e.g.:

```hcl
resource "aws_security_group_rule" "connector_inspector" {
  type              = "ingress"
  from_port         = 9090
  to_port           = 9090
  protocol          = "tcp"
  security_group_id = aws_security_group.connector_egress.id
  cidr_blocks       = ["10.0.0.0/16"]  # scope to your VPC, not 0.0.0.0/0
}
```

That alone doesn't expose anything unauthenticated: only `POST /oauth/token`
is ever reachable non-loopback, gated by a machine caller's own
`client_id`/`client_secret`, and only once an operator has added at least
one API client from the inspector's loopback session (or one already
exists from a prior boot) — the dashboard itself never becomes reachable
this way, under any configuration. See `docs/NETWORK-ACCESS.md`.
