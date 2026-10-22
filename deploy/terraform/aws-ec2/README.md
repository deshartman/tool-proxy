# tool-proxy on EC2, reached via EC2 Instance Connect Endpoint

One instance, no IAM, no inbound port from the internet.

## When to use this instead of Fargate

[`../aws-fargate/`](../aws-fargate/README.md) is the better shape — managed, no
VM to patch — but registering an ECS task definition requires `iam:PassRole`,
which a standard PowerUser permission set does not grant. Verified:

```bash
aws iam simulate-principal-policy --policy-source-arn <your-role-arn> \
  --action-names iam:CreateRole iam:PassRole ec2:RunInstances \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
```

If `iam:PassRole` comes back `implicitDeny`, Fargate is closed to you and this
module is the AWS path. **It needs no IAM at all** — the connector calls no AWS
API, so the instance needs no role, no instance profile, and therefore no
`PassRole`.

## Why EICE rather than SSM Session Manager

SSM is the more familiar choice and it does not work here: the SSM agent
authenticates using an **instance profile**, which is the thing `PassRole` gates.
EC2 Instance Connect Endpoint needs none, and gives two properties that matter:

- **The security group admits only the endpoint, on 22, inside the VPC.** Nothing
  is open to the internet. The connector's defining property is that it opens no
  inbound port; a VM deploy must not quietly break that.
- **The tunnel carries SSH**, and `ssh -L` over it reaches the host's loopback.

**EICE tunnels ONLY ports 22 and 3389.** An earlier version of this README
claimed `--remote-port` forwards arbitrary TCP. It does not: the CLI accepts the
flag and AWS refuses it at the websocket upgrade with
`InvalidParameter: The specified RemotePort is not valid`. Measured.

So the dashboard hop has **three** stages, and all three are needed:

1. `open-tunnel --remote-port 22 --local-port 2222` — EICE to SSH.
2. `ssh -L 9090:127.0.0.1:9090 -p 2222` through it — reaches the HOST's loopback.
3. A relay on the host into the **container's** network namespace. The connector
   binds `127.0.0.1` inside the container and the compose file publishes no port,
   so host loopback is still one hop short: measured on a live instance,
   `host->9090` is refused while `container->9090` returns 200.

**Stage 3 is installed for you** by user-data, as `mcp-inspector-relay.service`
— an `nsenter` + `socat` bridge that resolves the container pid at call time so
it survives a container restart. Same job as
`scripts/fly-inspector.sh`, same caveat: while it runs, anything that reaches
the host's loopback reaches the dashboard. Here that means only someone already
through EICE.

## Deploy

```bash
terraform init
terraform plan  -var connector_name=<name> -var region=us-west-2
terraform apply -var connector_name=<name> -var region=us-west-2
```

`plan` is worth reading: it calls AWS read-only and creates nothing, and it
resolves the default VPC, its subnets and the current AL2023 AMI, so a
permissions or region problem surfaces before anything exists.

Four resources: two security groups, the endpoint, the instance. No VPC — it
uses the region's **default VPC**, which is what makes this runnable with no
prior AWS setup.

### Pin `repo_ref` for anything you intend to keep

The instance clones a **public** git repo at first boot and builds the image
locally — no registry, and no AWS credentials on a box that deliberately has
none. `repo_ref` defaults to `main`, which makes the deployed code depend on
when the instance happened to boot. Pass a commit SHA for a reproducible host:

```bash
terraform apply -var connector_name=<name> -var region=us-west-2 \
  -var repo_ref=<sha>
```

The code must be **on the remote** at that ref. A local-only commit is not
enough, and the failure is confusing: the box builds the connector as it existed
at whatever `main` points to — which, before DB-TO-FILE, expects `POSTGRES_URL`
and crash-loops in `requireEnv()`.

## First boot takes 3-5 minutes

`dnf install`, a git clone, and a `docker build` all happen in user-data. Every
step logs to `/var/log/tool-proxy-boot.log`, because a first-boot failure is
otherwise invisible:

```bash
terraform output -raw check_boot    # prints the command, filled in
```

Then the verification gate — read the **`config-store`** line:

```bash
terraform output -raw doctor
```

| Verdict | Meaning |
|---|---|
| `ok … will be created at boot` | Correct before Configure Tunnel. |
| `ok … valid, key matches` | Correct after. |
| `FAIL … not writable` | The state directory is not writable by the image's `mcp` uid. |

`doctor` also reports `inspector-port :9090 already in use`. That is `doctor`
probing the port the connector itself is listening on — a known self-detection
quirk, not a deployment fault.

## The dashboard

Two shells, because of the three-stage hop above:

```bash
# Shell 1 - EICE tunnel to SSH
terraform output -raw open_dashboard_step1

# Authorise a throwaway key (valid 60s; nothing is stored on the instance)
ssh-keygen -t ed25519 -N "" -f /tmp/eice_key
terraform output -raw send_key

# Shell 2 - forward 9090 through that tunnel
ssh -i /tmp/eice_key -p 2222 -N -L 9090:127.0.0.1:9090 ec2-user@127.0.0.1
```

Then open `http://localhost:9090/`.

The explicit `http://` matters: Chrome's HSTS on `localhost` can force
`https://`, which the inspector does not serve, and the operator sees
`ERR_CONNECTION_RESET` and blames the deploy.

Fill in **Configure Tunnel** — controller URL, connector name matching the
controller's Tunnel Security row exactly (case-sensitive), auth posture. The
status pill should go `closed → connecting → open`. This modal is the **only**
way to set tunnel identity, so this tunnel is not a convenience: first-connect
cannot complete without it.

## Confirm there is no inbound surface

```bash
terraform output -raw no_inbound_surface
```

Expect exactly **one** ingress rule: port 22, `UserIdGroupPairs` naming the
endpoint's security group, and an empty `IpRanges`. If you see `0.0.0.0/0`,
something has been "helpfully" widened — revert it. The tunnel carries 9090 over
the same SSH channel, so opening 9090 buys nothing and would publish the
Webhooks panel's bcrypt-protected URLs.

## The master key, and what survives a rebuild

The key is minted **on the instance, by the instance** (`head -c 32
/dev/urandom`), so it never crosses the network and never enters Terraform state.
The consequence: it lives only on that root volume, alongside the sealed store at
`/var/lib/tool-proxy/state/config.json` in a Docker named volume.

- **`terraform destroy`, or replacing the instance, loses both.** The operator
  re-runs Configure Tunnel, and the re-register collides on `name_taken` against
  the controller's surviving row — a *sticky* error, so auto-reconnect stays
  suppressed until a human clicks Reconnect.
- **`user_data_replace_on_change = true`** means editing user-data REPLACES the
  instance. That is honest (you get a clean box) but it is not a config reload —
  read the previous point before changing it.
- Changing `repo_ref` also replaces the instance, for the same reason.

## Cost

`t3.small` on-demand in us-west-2 ≈ **$15/month** running, plus ~$1.60 for the
20 GB gp3 root. The endpoint is free. `terraform destroy` removes everything;
stopping the instance leaves only the EBS charge.

## What this does not do

- **Patch the OS.** You own the box. A `dnf update` cadence is yours to run; the
  Fargate module has no equivalent burden, which is the main reason to prefer it
  when `PassRole` is available.
- **Survive a region outage, or scale.** One instance, deliberately: identity
  binds `(tenant, name)` at register time, so a second connector sharing a name
  collides on the controller's duplicate-name guard.
- **Create a VPC.** It uses the default one. Pass `subnet_id` to place the
  instance somewhere specific.
