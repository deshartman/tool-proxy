# mcp-connector on a single EC2 instance, reached through EC2 Instance Connect
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
#   * `aws ec2-instance-connect open-tunnel` forwards ARBITRARY TCP via
#     --remote-port, so it also carries 9090. The forward terminates ON the
#     instance, so the connector sees a genuine 127.0.0.1 caller and the
#     dashboard's loopback gate is satisfied honestly rather than bypassed.
#
# That second point is load-bearing and was measured, not assumed: a plain port
# mapping into a container answers `403 forbidden: loopback only` because the
# gate judges the caller's source address. A forward that ORIGINATES inside the
# box returns 200. Same distinction applies here.

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
  name      = "mcp-connector-${var.connector_name}"
  subnet_id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default.ids[0]
}

# ── Security groups ─────────────────────────────────────────────────────────

# The endpoint's own SG. Egress to 22 within the VPC is all it needs; AWS
# terminates the client side of the tunnel.
resource "aws_security_group" "eice" {
  name        = "${local.name}-eice"
  description = "EC2 Instance Connect Endpoint for the mcp-connector host"
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
  description = "mcp-connector host: egress only, plus SSH from the EIC endpoint"
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
    Purpose = "mcp-connector (customer-side MCP tunnel)"
  }
}

locals {
  # Deliberately plain. Every failure mode here is "first boot did something
  # invisible", so each step logs to /var/log/mcp-connector-boot.log and the
  # README tells the operator to read it. cloud-init's own output also lands in
  # /var/log/cloud-init-output.log.
  user_data = <<-BASH
    #!/bin/bash
    set -euxo pipefail
    exec > >(tee -a /var/log/mcp-connector-boot.log) 2>&1
    echo "[boot] mcp-connector provisioning starting at $(date -Is)"

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

    git clone "${var.repo_url}" /opt/mcp-shim
    cd /opt/mcp-shim
    git checkout "${var.repo_ref}"
    echo "[boot] checked out $(git rev-parse HEAD)"

    cd /opt/mcp-shim/deploy/compose

    # The three files the compose stack needs and does not ship, per its README.
    mkdir -p secrets
    # The master key. Minted here, on the box, by the box: it never crosses the
    # network and never appears in Terraform state, a log, or a transcript.
    if [ ! -f secrets/connector.key ]; then
      head -c 32 /dev/urandom > secrets/connector.key
      chmod 400 secrets/connector.key
    fi
    # The bind-mount SOURCE must exist as a FILE first — Docker silently creates
    # a DIRECTORY otherwise and config load then fails.
    [ -f connector.yaml ] || printf 'mcp_servers: []\n' > connector.yaml

    # The compose file's customer-MCP mount is `../../customer-mcps`, which a
    # fresh clone does not contain (it is empty at ship time and therefore not
    # tracked). Docker would create it as a ROOT-OWNED directory, and the
    # scanner then cannot read it. Create it first, owned by the image's uid.
    mkdir -p /opt/mcp-shim/customer-mcps
    chown 1000:1000 /opt/mcp-shim/customer-mcps

    # Build locally rather than pulling: there is no published connector image,
    # and pulling from ECR would need AWS credentials on a box that deliberately
    # has none.
    #
    # Tag to match what the compose file asks for. It resolves
    # ghcr.io/twilio/mcp-connector:$MCP_VERSION, so a bare `mcp-connector:local`
    # tag would leave compose trying to PULL from ghcr — which issues no
    # anonymous token, so it fails with an auth error that reads as a network
    # problem. Tagging the full name makes the local image satisfy the
    # reference; Docker does not reach out for an image it already has.
    docker build -f /opt/mcp-shim/connector/Dockerfile \
      -t ghcr.io/twilio/mcp-connector:local /opt/mcp-shim
    MCP_VERSION=local docker compose up -d

    echo "[boot] done at $(date -Is). Container:"
    docker compose ps
  BASH
}
