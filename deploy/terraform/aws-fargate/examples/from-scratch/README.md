# From-scratch AWS Fargate deployment

For an operator who has an AWS account and nothing else. Creates the VPC, ECS
cluster, IAM roles and registry, then calls the core module at [`../..`](../../README.md)
for the connector.

The core module deliberately owns no networking — correct for organisations
whose VPCs belong to another team, and the reason this wrapper exists instead of
a `create_network` flag inside it.

| Owned here | Owned by the core module |
|---|---|
| VPC, 2 public subnets, IGW, route table | EFS filesystem + access point + mount targets + its SG |
| Task security group (egress only, **no ingress**) | Secrets Manager slot for the master key |
| ECS cluster | CloudWatch log group |
| Task role + execution role | Task definition + service (`desired_count = 1`) |
| ECR repository | |

## Before you start

**Check your AWS permissions first.** This creates resources across EC2, ECS,
IAM, EFS, Secrets Manager, ECR and CloudWatch Logs. A read-only or
service-scoped role (a Bedrock role, say) cannot do it, and you will find that
out one resource at a time.

```bash
aws sts get-caller-identity     # must succeed, and be the account you intend
terraform version               # >= 1.5
docker version                  # needed to build the image
```

You also need a **controller reachable over HTTPS** with a Tunnel Security row
whose Name matches the `connector_name` you pass below, case-sensitive. A
mismatch surfaces only as HTTP 401 at the WS upgrade, and nothing local can
detect it beforehand.

## Why this is a two-phase apply

An ECS service cannot pull an image that has not been pushed; the registry does
not exist until Terraform has run. A single `apply` creates both and the first
tasks die with `CannotPullContainerError`, which reads as a broken connector
rather than an empty registry. So:

### Phase 1 — foundation and registry

```bash
terraform init
terraform apply -var deploy_connector=false \
  -var connector_name=acme-prod -var region=us-west-2
```

Creates everything except the connector. Then build and push, from the
**repository root**:

```bash
terraform output -raw build_and_push   # prints the two commands below, filled in
```

```bash
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
IMAGE=<acct>.dkr.ecr.<region>.amazonaws.com/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh
```

`build-image.sh` is the script CI uses, so local and CI images are built
identically. It defaults to `linux/amd64,linux/arm64`.

### Phase 2 — the connector

```bash
terraform apply -var connector_name=acme-prod -var region=us-west-2
```

Then populate the one secret the connector needs. **Mint it with the command —
never paste key bytes into a ticket, a chat, or a terminal you do not control:**

```bash
terraform output -raw put_master_key    # prints the command, key generated in-process
```

The task will restart and stay up once the secret has a value.

## First connect

Nothing above set a controller URL, a connector name, or an auth posture —
there are no env vars for them. They are typed into the inspector's
**Configure Tunnel** modal, and reaching that modal requires arriving as a
**loopback** caller, because every dashboard route refuses anything else.

`enable_execute_command = true` is set on the service for exactly this reason.
ECS Exec enters the task's namespace:

```bash
terraform output -raw open_dashboard    # prints the two commands, filled in
```

Start with `doctor`, and read the **`config-store`** line:

| Verdict | Meaning |
|---|---|
| `ok … will be created at boot` | Correct on a first deploy. |
| `ok … valid, key matches` | Correct after Configure Tunnel. |
| `FAIL … not writable` | The EFS access point's uid/gid does not match the image's `mcp` user (1000). The core module's access point exists to prevent this. |
| `FAIL … different master key` | The secret was rotated without replacing the filesystem. There is no re-seal path. |

To reach the dashboard in a browser rather than a shell, port-forward through
SSM. The agent dials `localhost` inside the task, so the connector sees a
genuine loopback caller:

```bash
aws ssm start-session --region <region> \
  --target "ecs:<cluster>_<task-id>_<runtime-id>" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["9090"],"localPortNumber":["9090"]}'
```

Then open **`http://localhost:9090/`** — the explicit `http://` matters, as
Chrome's HSTS on `localhost` can force `https://`, which the inspector does not
serve. Fill in Configure Tunnel; the status pill should go
`closed → connecting → open`.

> **Untested link.** SSM port-forwarding to an ECS task has not been verified
> against this connector. If the dashboard 403s, the forward is not presenting as
> loopback — fall back to a relay inside the task, mirroring
> [`scripts/fly-inspector.sh`](../../../../../scripts/fly-inspector.sh), which
> solves the identical problem on Fly.

## The EFS filesystem is the connector's identity

`state/config.json` on it holds the sealed tunnel bearer and the registration
token. Consequences worth knowing before an incident rather than during one:

- **Deleting it is not a harmless reset.** The operator must re-run Configure
  Tunnel, and the re-register collides on `name_taken` against the controller's
  surviving row — a *sticky* error, so auto-reconnect stays suppressed until a
  human clicks Reconnect. (An unknown *registration token* self-heals silently;
  a taken *name* does not.)
- **Back it up with the key or not at all.** A snapshot without the master key
  decrypts to nothing, which is the point of sealing it.
- **Rotating the key does not re-seal the store.** `ConfigStore.open()` compares
  a fingerprint and refuses to start against a store sealed with a different
  key.

## Cost

Roughly, in `us-west-2`, idle: Fargate 0.5 vCPU / 2 GB ≈ **$18/month**, EFS
under a megabyte ≈ **$0.01**, Secrets Manager **$0.40**, CloudWatch Logs
pennies, ECR storage pennies. **No NAT gateway** — that is the single biggest
line item this example avoids by using public subnets with no inbound rules,
and it is why `assign_public_ip = true` is the default rather than an
embarrassment.

There is **no database**, which is what changed: the connector used to require a
managed Postgres per cloud purely to hold four secrets.

## Teardown

```bash
terraform destroy -var connector_name=acme-prod -var region=us-west-2
```

`destroy` **fails while the ECR repository still holds images** — deliberately,
so a teardown cannot silently discard them. Either delete the images first, or
re-run with `-var ecr_force_delete=true`.

Destroy also takes the EFS filesystem, and with it the connector's identity. Its
`connectors` row survives on the controller, so a later redeploy under the same
name hits `name_taken` until someone clears that row.
