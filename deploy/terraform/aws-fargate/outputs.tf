output "task_definition_arn" {
  description = "ARN of the connector task definition."
  value       = aws_ecs_task_definition.connector.arn
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.connector.name
}

output "log_group_name" {
  description = "CloudWatch log group for the connector's stdout."
  value       = aws_cloudwatch_log_group.connector.name
}

output "tunnel_auth_token_arn" {
  description = "Secrets Manager ARN — populate this with `aws secretsmanager put-secret-value` after minting a Tunnel Security row on the controller."
  value       = aws_secretsmanager_secret.tunnel_auth_token.arn
}
