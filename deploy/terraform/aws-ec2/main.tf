# tool-proxy on a single EC2 instance, reached through EC2 Instance Connect
# Endpoint (EICE).
#
# WHY THIS MODULE EXISTS, AND WHEN NOT TO USE IT
#
# deploy/terraform/aws-fargate/ is the better shape — managed, no VM to patch —
# but registering an ECS task definition requires `iam:PassRole`, which a
# standard PowerUser permission set does not grant. Verified with
# `aws iam simulate-principal-policy`: iam:CreateRole, iam:AttachRolePolicy,
# iam:PutRolePolicy and iam:PassRole all return implicitDeny, while every EC2,
# ECS, EFS, ECR and Secrets Manager action needed returns allowed.
#
# This module needs NO IAM at all. That is not a trick: the connector calls no
# AWS API. It dials the controller over WSS and reads a local key file, so the
# instance needs no role, no instance profile, and therefore no PassRole.
#
# Prefer the Fargate module if you can get `iam:PassRole` on two roles. Use this
# when you cannot, or when you want one box you fully control.
#
# HOW YOU REACH IT, AND WHY IT IS NOT SSH
#
# EICE is an AWS-managed tunnel into a private instance. It needs no instance
# profile (unlike SSM Session Manager, whose agent authenticates with one — the
# reason this module does not use SSM). Two properties matter:
#
#   * The security group allows 22 ONLY from the endpoint, inside the VPC.
#     Nothing is open to the internet. The connector's defining property is that
#     it opens no inbound port, and a VM deploy must not quietly break that.
#   * The tunnel carries SSH, and `ssh -L` over it reaches the dashboard.
#
# CORRECTED AFTER MEASURING. An earlier version of this comment claimed
# `open-tunnel --remote-port` forwards arbitrary TCP, so it could carry 9090
# directly. It cannot: the CLI accepts the flag and AWS rejects it at the
# websocket upgrade with
#   InvalidParameter: The specified RemotePort is not valid. Specify either 22
#   or 3389 as the RemotePort
# So the dashboard hop is a two-stage thing, and BOTH stages are needed:
#
#   1. `open-tunnel --remote-port 22 --local-port 2222`, then
#      `ssh -L 9090:127.0.0.1:9090 -p 2222 ec2-user@127.0.0.1` through it. That
#      gets you to the HOST's loopback.
#   2. A relay on the host into the container's network namespace. The connector
#      binds 127.0.0.1 INSIDE the container, and the compose file publishes no
#      port (deliberately — a published port cannot reach it and a wide bind
#      answers 403), so host loopback is still one hop short. Measured on this
#      instance: host->9090 refused, container->9090 returns 200.
#
# user-data installs that relay as a systemd unit, so the operator only does
# stage 1. See local.relay_unit below.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Amazon Linux 2023: docker and git are in its repos, and it ships the EIC
# agent, so no third-party AMI and no SSH key material anywhere.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }
}

locals {
  name      = "tool-proxy-${var.connector_name}"
  subnet_id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default.ids[0]
}

# ── Security groups ─────────────────────────────────────────────────────────

# The endpoint's own SG. Egress to 22 within the VPC is all it needs; AWS
# terminates the client side of the tunnel.
resource "aws_security_group" "eice" {
  name        = "${local.name}-eice"
  description = "EC2 Instance Connect Endpoint for the tool-proxy host"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "SSH to the connector instance"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.default.cidr_block]
  }

  tags = { Name = "${local.name}-eice" }
}

# The instance's SG. ONE ingress rule, sourced from the endpoint's SG rather
# than a CIDR — so only the endpoint can reach 22, and only from inside the VPC.
#
# Do NOT add 0.0.0.0/0 on 22 "to make SSH work", and do not open 9090 at all.
# The tunnel carries 9090 over the SAME SSH channel, so a second rule buys
# nothing and would publish the dashboard's bcrypt-protected webhook URLs to
# whatever the CIDR admits.
resource "aws_security_group" "instance" {
  name        = "${local.name}-instance"
  description = "tool-proxy host: egress only, plus SSH from the EIC endpoint"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "SSH from the EIC endpoint only"
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.eice.id]
  }

  egress {
    description = "All outbound: controller WSS, image registries, OS packages"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-instance" }
}

resource "aws_ec2_instance_connect_endpoint" "main" {
  subnet_id          = local.subnet_id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false

  tags = { Name = local.name }
}

# ── The instance ────────────────────────────────────────────────────────────

resource "aws_instance" "connector" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.instance.id]

  # NO iam_instance_profile. The connector calls no AWS API, and attaching one
  # would require iam:PassRole — the permission this whole module exists to
  # avoid needing. If you later add something that does call AWS, that is the
  # moment to reconsider, not now.

  # A public IP is how the instance reaches the internet from a default-VPC
  # public subnet: it needs to clone the repo, pull base images, install
  # packages and dial the controller. It does NOT make the instance reachable —
  # that is decided by the security group above, which admits only the endpoint
  # on 22. Set this false only alongside a NAT gateway.
  associate_public_ip_address = true

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # Metadata v2 required: v1's unauthenticated HTTP GET is reachable from any
  # process on the box, including a compromised MCP child.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  user_data                   = local.user_data
  user_data_replace_on_change = true

  tags = {
    Name = local.name
    # This is a shared account; make ownership legible to whoever finds it.
    Purpose = "tool-proxy (customer-side MCP tunnel)"
  }
}

locals {
  # Deliberately plain. Every failure mode here is "first boot did something
  # invisible", so each step logs to /var/log/tool-proxy-boot.log and the
  # README tells the operator to read it. cloud-init's own output also lands in
  # /var/log/cloud-init-output.log.
  user_data = <<-BASH
    #!/bin/bash
    set -euxo pipefail
    exec > >(tee -a /var/log/tool-proxy-boot.log) 2>&1
    echo "[boot] tool-proxy provisioning starting at $(date -Is)"

    dnf -y install docker git
    systemctl enable --now docker

    # The compose PLUGIN, not the standalone binary: deploy/compose uses
    # `docker compose` (v2 syntax) and the v1 `docker-compose` script cannot
    # parse it.
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64"
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    docker compose version

    mkdir -p /opt/tool-proxy
    chown 1000:1000 /opt/tool-proxy

    # ── The dashboard hop ────────────────────────────────────────────────
    # The connector binds 127.0.0.1 inside the container and the compose file
    # publishes no port, so nothing on the host can reach the inspector — and
    # `ssh -L` lands on the HOST. This relay bridges that last hop by entering
    # the container's network namespace with nsenter, so the connector still
    # sees a genuine 127.0.0.1 caller and its loopback gate is satisfied
    # honestly rather than widened.
    #
    # Same job as scripts/fly-inspector.sh, and the same caveat: while it runs,
    # anything that can reach the host's loopback can reach the dashboard. On
    # this instance that means only someone already through EICE, which is why
    # it is acceptable here and was not on Fly's shared mesh.
    dnf -y install socat
    cat > /usr/local/bin/mcp-relay-inner <<'INNER'
    #!/bin/sh
    # Resolved at call time, not install time: the pid changes on every
    # container restart, and a baked-in pid fails silently after one.
    CID=$(docker inspect -f '{{.State.Pid}}' compose-connector-1)
    exec nsenter -t "$CID" -n socat STDIO TCP:127.0.0.1:9090
    INNER
    sed -i 's/^    //' /usr/local/bin/mcp-relay-inner
    chmod 755 /usr/local/bin/mcp-relay-inner

    cat > /etc/systemd/system/mcp-inspector-relay.service <<'UNIT'
    [Unit]
    Description=Relay host loopback 9090 into the connector container netns
    After=docker.service
    Requires=docker.service

    [Service]
    ExecStart=/usr/bin/socat TCP-LISTEN:9090,bind=127.0.0.1,reuseaddr,fork EXEC:/usr/local/bin/mcp-relay-inner
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    UNIT
    sed -i 's/^    //' /etc/systemd/system/mcp-inspector-relay.service
    systemctl daemon-reload
    systemctl enable --now mcp-inspector-relay

    # The early exit sits AFTER the relay on purpose. The relay is needed however
    # the code arrives, and it resolves the container pid at call time, so
    # installing it before the container exists is fine — socat retries.
    ${var.bootstrap_code ? "" : "echo '[boot] bootstrap_code=false: Docker + relay ready, awaiting an uploaded tree at /opt/tool-proxy'; exit 0"}

    git clone "${var.repo_url}" /opt/tool-proxy-src
    mv /opt/tool-proxy-src/* /opt/tool-proxy-src/.git /opt/tool-proxy/ 2>/dev/null || true
    rmdir /opt/tool-proxy-src 2>/dev/null || true
    cd /opt/tool-proxy
    git checkout "${var.repo_ref}"
    echo "[boot] checked out $(git rev-parse HEAD)"

    cd /opt/tool-proxy/deploy/compose

    # The three files the compose stack needs and does not ship, per its README.
    mkdir -p secrets
    # The master key. Minted here, on the box, by the box: it never crosses the
    # network and never appears in Terraform state, a log, or a transcript.
    if [ ! -f secrets/connector.key ]; then
      head -c 32 /dev/urandom > secrets/connector.key
      # uid 100 is the image's `mcp` user (Alpine `adduser -S`), NOT 1000. The
      # compose file mounts this read-only, so the entrypoint cannot chown it —
      # a mode-0400 file owned by anyone else crash-loops the connector on
      # EACCES: permission denied, open '/etc/tool-proxy/connector.key'.
      # Measured on a real EC2 host; Docker Desktop on macOS hides it.
      chown 100:101 secrets/connector.key
      chmod 400 secrets/connector.key
    fi
    # The bind-mount SOURCE must exist as a FILE first — Docker silently creates
    # a DIRECTORY otherwise and config load then fails.
    [ -f connector.yaml ] || printf 'mcp_servers: []\n' > connector.yaml

    # The compose file's customer-MCP mount is `../../customer-mcps`, which a
    # fresh clone does not contain (it is empty at ship time and therefore not
    # tracked). Docker would create it as a ROOT-OWNED directory, and the
    # scanner then cannot read it. Create it first, owned by the image's uid.
    mkdir -p /opt/tool-proxy/customer-mcps
    chown 100:101 /opt/tool-proxy/customer-mcps

    # Build locally rather than pulling: there is no published connector image,
    # and pulling from ECR would need AWS credentials on a box that deliberately
    # has none.
    #
    # Tag to match what the compose file asks for. It resolves
    # ghcr.io/twilio/tool-proxy:$MCP_VERSION, so a bare `tool-proxy:local`
    # tag would leave compose trying to PULL from ghcr — which issues no
    # anonymous token, so it fails with an auth error that reads as a network
    # problem. Tagging the full name makes the local image satisfy the
    # reference; Docker does not reach out for an image it already has.
    docker build -f /opt/tool-proxy/connector/Dockerfile \
      -t ghcr.io/twilio/tool-proxy:local /opt/tool-proxy
    # -f IS REQUIRED: deploy/compose ships docker-compose.prod.yml and
    # .dev.yml but no docker-compose.yml, so a bare `docker compose up`
    # fails with "no configuration file provided: not found".
    MCP_VERSION=local docker compose -f docker-compose.prod.yml up -d

    echo "[boot] done at $(date -Is). Container:"
    docker compose -f docker-compose.prod.yml ps
    echo "[boot] relay: $(systemctl is-active mcp-inspector-relay)"
  BASH
}
