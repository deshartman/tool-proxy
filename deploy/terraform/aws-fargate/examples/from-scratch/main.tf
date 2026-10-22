# From-scratch AWS deployment for the tool-proxy.
#
# Creates everything an operator with nothing but an IAM account needs, then
# calls the core module at ../.. for the connector itself.
#
# The core module deliberately does NOT create networking, a cluster, or IAM
# roles — that is correct for organisations whose VPCs are owned by another
# team, and it is why this example exists rather than a `create_network` toggle
# inside the module. A count/for_each on networking is where Terraform modules
# rot; composition does not.
#
#   This example owns:  VPC, 2 public subnets, IGW, route table, task security
#                       group, ECS cluster, task + execution roles, ECR repo.
#   The module owns:    EFS filesystem + access point + mount targets + its SG,
#                       Secrets Manager slot, log group, task definition, service.
#
# READ THE README FIRST — this is a TWO-PHASE apply. An ECS service cannot pull
# an image that has not been pushed yet, and the registry does not exist until
# Terraform has run once.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  name = "tool-proxy-${var.connector_name}"

  # EFS mount targets need one subnet per AZ the task can land in, and an EFS
  # subnet group needs at least two AZs. Two is the minimum that works.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  image = "${aws_ecr_repository.connector.repository_url}:${var.image_tag}"

  # Built rather than read from the module's output on purpose. The module needs
  # execution_role_arn as an INPUT, so reading its secret ARN here would be a
  # dependency cycle; scoping by ARN PATTERN breaks it without widening to "*".
  # Secrets Manager appends a random 6-character suffix, hence the trailing -*.
  # The name must track the module's `aws_secretsmanager_secret.connector_key`.
  key_secret_arn_pattern = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tool-proxy/${var.connector_name}/connector-key-b64-*"
}

# ── Network ─────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# PUBLIC subnets, and the task gets a public IP. That pairing is what gives the
# task a route to the internet, which it needs for ECR, Secrets Manager, EFS and
# the controller.
#
# "Outbound-only" describes what reaches the CONNECTOR, not what the connector
# needs to reach. The invariant is held by the security group below having no
# ingress rules and by there being no load balancer — not by withholding a route.
# A private-subnet variant is the same module with a NAT gateway and
# assign_public_ip = false; that costs ~$32/month per NAT, which is why this
# example does not default to it.
resource "aws_subnet" "public" {
  for_each = { for i, az in local.azs : az => i }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = local.name }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# ── Task security group ─────────────────────────────────────────────────────
#
# NO INGRESS RULES. That absence is the outbound-only invariant, and it is the
# thing to preserve if you edit this file. The connector opens no inbound port;
# the controller pushes RPC back down the WS the connector itself opened.
#
# Egress is left open rather than enumerated. The task needs 443 to four
# different services (ECR's API, ECR's S3-backed layer store, Secrets Manager,
# the controller), 2049 to EFS, and 53 for DNS — and a subtly wrong egress rule
# produces CannotPullContainerError, which reads as a broken image rather than a
# broken rule. Tighten it with VPC endpoints when you have a reason to; do not
# tighten it by guessing at port lists.
resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "tool-proxy task: egress only, no inbound"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "All outbound. No ingress rules by design (see comment above)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-task" }
}

# ── ECS cluster ─────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = local.name
}

# ── IAM ─────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The EXECUTION role is the ECS agent's identity: it pulls the image, writes to
# CloudWatch, and fetches `secrets[]` BEFORE the container starts. Secret
# injection is its job, not the task role's — getting that backwards is a
# common and confusing failure, because the task then starts and immediately
# fails on a missing env var.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-connector-key"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [local.key_secret_arn_pattern]
    }]
  })
}

# The TASK role is the running container's identity. Two things need it, and
# both are easy to omit with no visible error until much later.
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  name = "efs-and-exec"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The module sets `iam = "ENABLED"` on the EFS authorization config, so
        # the MOUNT itself authenticates as this role. Without these the task
        # starts and then cannot write its config store.
        #
        # Scoped to "*" deliberately: the filesystem is created by the module,
        # which takes this role's ARN as an input, so naming the filesystem here
        # would be a dependency cycle. Narrowing it after the first apply is a
        # reasonable hardening step — the id is in the `state_file_system_id`
        # output.
        Effect   = "Allow"
        Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource = ["*"]
      },
      {
        # ECS Exec. This is NOT optional plumbing: the inspector's dashboard
        # refuses every non-loopback caller, and the Configure Tunnel modal is
        # the ONLY way to set tunnel identity — no env var, no CLI flag. ECS
        # Exec enters the task's namespace, so it is the hop that makes
        # first-connect possible. Omit these four and `execute-command` fails
        # with a TargetNotConnectedException that says nothing about IAM.
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = ["*"]
      },
    ]
  })
}

# ── Registry ────────────────────────────────────────────────────────────────
#
# There is no published connector image — ghcr.io/twilio-demos/tool-proxy is a
# placeholder and ghcr issues no anonymous pull token. You build and push your
# own, which is what this repository exists for.
resource "aws_ecr_repository" "connector" {
  name                 = "tool-proxy"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ── The connector ───────────────────────────────────────────────────────────
#
# Gated so the first apply can stop after the registry exists. See the
# `deploy_connector` variable and the README's two-phase walkthrough.
module "connector" {
  source = "../.."
  count  = var.deploy_connector ? 1 : 0

  connector_name     = var.connector_name
  region             = var.region
  image              = local.image
  log_retention_days = var.log_retention_days

  cluster_arn        = aws_ecs_cluster.main.arn
  task_role_arn      = aws_iam_role.task.arn
  execution_role_arn = aws_iam_role.execution.arn

  vpc_id            = aws_vpc.main.id
  subnet_ids        = [for s in aws_subnet.public : s.id]
  security_group_id = aws_security_group.task.id

  # Public subnets, so the task needs its own address to reach the internet.
  # Flip to false only alongside a NAT gateway.
  assign_public_ip = true
}
