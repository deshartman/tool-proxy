# AWS Fargate deployment for the tool-proxy.
#
# What this module owns:
#   - CloudWatch log group for the task's stdout.
#   - Secrets Manager secret for the master key (empty by default; you
#     populate it out-of-band).
#   - An EFS filesystem + access point for the connector's state, and a
#     security group allowing NFS from the task.
#   - ECS task definition + service (Fargate, replicas=1).
#
# What this module does NOT own (caller supplies as inputs):
#   - The ECS cluster, task role, execution role.
#   - Networking (VPC, subnets, security group).
#   - The master key value itself. `aws secretsmanager put-secret-value` it in
#     from your secrets pipeline; Terraform managing the value would put it in
#     tfstate.
#
# The deliberate exclusion of networking is correct for orgs whose VPCs are
# owned elsewhere. If you have none of it, compose this module with your own
# VPC/cluster/roles rather than adding a `create_network` toggle here — a
# count/for_each on networking is where Terraform modules rot.

resource "aws_cloudwatch_log_group" "connector" {
  name              = "/ecs/tool-proxy-${var.connector_name}"
  retention_in_days = var.log_retention_days
}

# The connector's ENTIRE secret surface: one 32-byte libsodium master key,
# base64-encoded. The entrypoint decodes it into CONNECTOR_KEY_FILE at 0400 and
# unsets it before dropping privileges.
#
# This replaced a `tunnel_auth_token` secret. That, and the OAuth2 trio, were
# retired by ENV-TO-DB: the auth posture is chosen in the inspector's Configure
# Tunnel modal and sealed into the state volume under this key. There is no
# env-var form of tunnel identity, so this module needs no posture input.
resource "aws_secretsmanager_secret" "connector_key" {
  name        = "tool-proxy/${var.connector_name}/connector-key-b64"
  description = "Base64 32-byte libsodium master key sealing the connector's config store (${var.connector_name})."
}

# ── State: EFS, not an ephemeral task volume ────────────────────────────────
#
# `state/config.json` on this filesystem holds the sealed tunnel bearer and the
# registration token the controller issued. This module previously declared
# `volume { name = "state" }` with no configuration — a bare Fargate ephemeral
# volume, recreated empty on every task start. Since DB-TO-FILE moved identity
# onto that volume, that would mean:
#   - the operator is asked to re-run Configure Tunnel after every restart, and
#   - the re-register collides on `name_taken` against the controller's
#     surviving row, which is STICKY: auto-reconnect is suppressed and a human
#     must click Reconnect.
# Unattended restart would be impossible. EFS is therefore required, not an
# upgrade.

resource "aws_efs_file_system" "state" {
  creation_token = "tool-proxy-${var.connector_name}-state"
  encrypted      = true

  tags = {
    Name = "tool-proxy-${var.connector_name}-state"
  }
}

# Pins the POSIX identity of the mount, which is what makes it writable by the
# container's non-root user. The image runs as mcp:mcp (uid/gid 1000);
# entrypoint.sh then creates and chowns state/ beneath this root while it is
# still root. Without the access point the mount lands root-owned and the
# connector cannot write its store.
resource "aws_efs_access_point" "state" {
  file_system_id = aws_efs_file_system.state.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/tool-proxy-${var.connector_name}"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }
}

# NFS from the task's security group only. EFS is reachable on 2049 from
# anything that can route to the mount target, so this is the boundary.
resource "aws_security_group" "efs" {
  name        = "tool-proxy-${var.connector_name}-efs"
  description = "NFS from the tool-proxy task to its state filesystem"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from the connector task"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [var.security_group_id]
  }
}

# One mount target per subnet the task can run in, or the mount fails in
# whichever AZ it lands in — an intermittent failure that looks like a flaky
# deploy.
resource "aws_efs_mount_target" "state" {
  for_each        = toset(var.subnet_ids)
  file_system_id  = aws_efs_file_system.state.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_ecs_task_definition" "connector" {
  family                   = "tool-proxy-${var.connector_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  # Measured floor is 493 MB: the connector plus the four bundled MCPs, where
  # each Type 1 child is THREE processes (a tsx wrapper node, the real node, and
  # a resident esbuild service). memory = "512" cannot boot the shipped image,
  # and the symptom is the fourth child dying at its readiness probe with no
  # output — which reads as a broken MCP rather than an undersized task.
  # MCP_READINESS_TIMEOUT_MS does not help: the memory is absent, not late.
  cpu                = var.task_cpu
  memory             = var.task_memory
  task_role_arn      = var.task_role_arn
  execution_role_arn = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name      = "connector"
      image     = var.image
      essential = true
      # CONNECTOR_KEY_FILE is the ONLY variable requireEnv() demands. It must be
      # set explicitly even though entrypoint.sh defaults to the same path
      # internally: the entrypoint does not EXPORT its default, so leaving this
      # unset writes the key and then fails the preflight.
      environment = [
        { name = "CONNECTOR_CONFIG", value = "/etc/tool-proxy/config.yaml" },
        { name = "CONNECTOR_KEY_FILE", value = "/etc/tool-proxy/connector.key" },
        { name = "INSPECTOR_PORT", value = "9090" },
        # Orchestrator probes, bound 0.0.0.0 with two GET-only routes. 9100
        # avoids 9091, which the multi-instance dev script uses as a second
        # inspector port.
        { name = "HEALTH_PORT", value = "9100" }
      ]
      # Read by the EXECUTION role, not the task role — injection happens before
      # the container starts.
      secrets = [
        {
          name      = "CONNECTOR_KEY_B64"
          valueFrom = aws_secretsmanager_secret.connector_key.arn
        }
      ]
      # One mount. There is deliberately NO mount at /etc/tool-proxy: the
      # entrypoint writes the decoded key there, so a read-only or shadowing
      # mount breaks boot. This module used to mount an ephemeral `config`
      # volume over exactly that path.
      mountPoints = [
        { containerPath = "/var/lib/tool-proxy", sourceVolume = "state" }
      ]
      # Probes /readyz on HEALTH_PORT, which returns 503 until the tunnel is
      # open — so ECS stops counting a connector healthy when it has no
      # controller. This used to hit the inspector's "/" instead, which only
      # proved the HTTP server answered.
      #
      # Still a CMD-SHELL exec: a Fargate task with no load balancer has no other
      # probe mechanism. The health server binds 0.0.0.0, but nothing outside the
      # task can route to it here — which is fine, since the invariant is that
      # nothing reaches the connector inbound.
      #
      # startPeriod is 90s because /readyz stays 503 until Configure Tunnel has
      # been completed — a human step on a first deploy. Probe /livez instead if
      # you need the task marked healthy before that: it answers 200 as soon as
      # the process is up and never consults the tunnel.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:9100/readyz >/dev/null 2>&1 || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 90
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.connector.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "connector"
        }
      }
    }
  ])

  volume {
    name = "state"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.state.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.state.id
        # Uses the TASK role, which therefore needs
        # elasticfilesystem:ClientMount + ClientWrite.
        iam = "ENABLED"
      }
    }
  }
}

resource "aws_ecs_service" "connector" {
  name            = "tool-proxy-${var.connector_name}"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.connector.arn
  # Single replica by design — the connector is stateful (its sealed identity
  # lives on the EFS volume) and each replica would open its own tunnel,
  # tripping the controller's dup-name guard.
  desired_count = 1
  launch_type   = "FARGATE"

  # ECS Exec is how an operator reaches the inspector dashboard: it enters the
  # task's namespace, so the connector sees a genuine loopback caller. Since the
  # Configure Tunnel modal is the ONLY way to set tunnel identity, a deployment
  # cannot complete first-connect without this enabled.
  enable_execute_command = true

  # The mount targets must exist before a task tries to mount the filesystem.
  depends_on = [aws_efs_mount_target.state]

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [var.security_group_id]

    # OUTBOUND-ONLY IS NOT THE SAME AS NEEDING NO EGRESS, and this line used to
    # read `false` with the comment "No public IP needed — connector is
    # outbound-only". With no public IP and no NAT gateway the task has no route
    # to the internet at all: it cannot pull from ECR, reach Secrets Manager, or
    # reach the controller, and it dies with CannotPullContainerError before any
    # connector code runs.
    #
    # Set this to false ONLY if the subnets in var.subnet_ids route egress
    # through a NAT gateway. The invariant that matters is that nothing reaches
    # the connector INBOUND — which is enforced by the security group having no
    # ingress rules and by there being no load balancer, not by this flag.
    assign_public_ip = var.assign_public_ip
  }

  # Task-role-managed reconnect: exit non-zero on tunnel close leaves it to
  # ECS to replace. Auto-reconnect is ON by default in the connector; set
  # `policy.reconnect.enabled: false` in connector.yaml if you want
  # ECS-managed replacement instead of in-process redial.
}
