# AWS Fargate deployment for the mcp-connector.
#
# What this module owns:
#   - CloudWatch log group for the task's stdout.
#   - Secrets Manager secret for the tunnel bearer (empty by default; you
#     populate it out-of-band).
#   - ECS task definition + service (Fargate, replicas=1).
#
# What this module does NOT own (caller supplies as inputs):
#   - The ECS cluster, task role, execution role.
#   - Networking (VPC, subnets, security group).
#   - The tunnel bearer value itself. `aws secretsmanager put-secret-value`
#     it in from your secrets pipeline; Terraform managing the value would
#     put it in tfstate.

resource "aws_cloudwatch_log_group" "connector" {
  name              = "/ecs/mcp-connector-${var.connector_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_secretsmanager_secret" "tunnel_auth_token" {
  name        = "mcp-connector/${var.connector_name}/tunnel-auth-token"
  description = "Static bearer minted by the controller's Tunnel Security row (${var.connector_name})."
}

resource "aws_ecs_task_definition" "connector" {
  family                   = "mcp-connector-${var.connector_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  task_role_arn            = var.task_role_arn
  execution_role_arn       = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name      = "connector"
      image     = var.image
      essential = true
      environment = [
        { name = "CONNECTOR_CONFIG",       value = "/etc/mcp-connector/config.yaml" },
        { name = "CONNECTOR_NAME",         value = var.connector_name },
        { name = "CONTROLLER_URL",         value = var.controller_url },
        { name = "INSPECTOR_PORT",         value = "9090" }
      ]
      secrets = [
        {
          name      = "TUNNEL_AUTH_TOKEN"
          valueFrom = aws_secretsmanager_secret.tunnel_auth_token.arn
        }
      ]
      mountPoints = [
        { containerPath = "/etc/mcp-connector",  sourceVolume = "config" },
        { containerPath = "/var/lib/mcp-connector", sourceVolume = "state" }
      ]
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
    name = "config"
  }

  volume {
    name = "state"
  }
}

resource "aws_ecs_service" "connector" {
  name            = "mcp-connector-${var.connector_name}"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.connector.arn
  # Single replica by design — the connector is stateful (registrationToken)
  # and each replica would open its own tunnel, tripping the controller's
  # dup-name guard.
  desired_count = 1
  launch_type   = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    # No public IP needed — connector is outbound-only.
    assign_public_ip = false
  }

  # Task-role-managed reconnect: exit non-zero on tunnel close leaves it to
  # ECS to replace. Configure inside the connector.yaml (`policy.reconnect.enabled: false`)
  # if you want ECS-managed instead of in-process reconnect.
}
