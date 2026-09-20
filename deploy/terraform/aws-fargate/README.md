# mcp-connector Terraform module — AWS Fargate

Deploys a single-replica Fargate service running the mcp-connector.

## Prerequisites (out of scope for this module)

- ECS cluster (`cluster_arn`)
- Task role + execution role
- Subnets with outbound TLS 443 egress
- Security group for the task. Needs **egress** on 443 (controller, ECR,
  Secrets Manager) and 2049 (EFS). No inbound rules — the connector dials out.
- A Tunnel Security row minted on the controller UI. Its bearer is **not** put
  in Secrets Manager: you paste it into the inspector's Configure Tunnel modal
  after the task is running, and the connector seals it onto the EFS volume.

This module DOES create the EFS filesystem, access point, mount targets and
their security group. That is new — the state volume used to be a bare
ephemeral Fargate volume, which since DB-TO-FILE would lose the connector's
identity on every task restart.

## Usage

```hcl
module "connector" {
  source = "github.com/twilio/mcp-shim//deploy/terraform/aws-fargate?ref=main"

  connector_name     = "prod-us-east-1"
  region             = "us-east-1"
  cluster_arn        = aws_ecs_cluster.main.arn
  task_role_arn      = aws_iam_role.connector_task.arn
  execution_role_arn = aws_iam_role.connector_exec.arn
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.private_subnets
  security_group_id  = aws_security_group.connector_egress.id

  # Private subnets with a NAT gateway can set this false. PUBLIC subnets must
  # leave it true, or the task has no route to the internet: it cannot pull from
  # ECR and dies with CannotPullContainerError before any connector code runs.
  # "Outbound-only" describes what reaches the connector, not what it needs to
  # reach — that invariant is held by the security group having no ingress
  # rules, not by this flag.
  assign_public_ip = false
}

# After `terraform apply`, populate the ONE secret out-of-band. Mint it with a
# command — never paste key bytes into a ticket or a chat:
#
#   aws secretsmanager put-secret-value \
#     --secret-id $(terraform output -raw connector_key_secret_arn) \
#     --secret-string "$(head -c 32 /dev/urandom | base64)"
```

**`controller_url` is gone as an input.** It used to be passed to the container
as `CONTROLLER_URL`; that variable was retired by ENV-TO-DB, so the input was
doing nothing. It is deleted rather than ignored — an input no resource reads is
exactly how the Helm chart ended up demanding four dead values — so a caller
still passing it gets a loud "argument not expected here" rather than silence.

## First connect

Nothing above set a controller URL, a connector name, or an auth posture, because
there are no env vars for them. `enable_execute_command = true` is set on the
service for this reason: ECS Exec enters the task's namespace, so the connector
sees a genuine **loopback** caller, and every dashboard route refuses anything
else.

```bash
aws ecs execute-command --cluster <c> --task <t> --container connector \
  --interactive --command "node dist/index.js doctor"
```

Read the `config-store` check: on a first deploy it should say
`will be created at boot`, and after Configure Tunnel `valid, key matches`. If it
says `not writable`, the EFS access point's uid/gid does not match the image's
`mcp` user (1000) — that is the failure this module's access point exists to
prevent.

Then port-forward and fill in the modal. The connector name you type must match
the controller's Tunnel Security row Name exactly (case-sensitive); a mismatch
surfaces only as HTTP 401 at the WS upgrade.

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
