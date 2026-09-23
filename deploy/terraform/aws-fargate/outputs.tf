output "task_definition_arn" {
  description = "ARN of the registered task definition revision."
  value       = aws_ecs_task_definition.connector.arn
}

output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.connector.name
}

output "log_group_name" {
  description = "CloudWatch log group carrying the task's stdout."
  value       = aws_cloudwatch_log_group.connector.name
}

# Replaces the former `tunnel_auth_token_arn`. The bearer is no longer an env
# var — it is entered in Configure Tunnel and sealed under this key.
output "connector_key_secret_arn" {
  description = "Secrets Manager ARN to populate with the base64 master key. Empty until you run: aws secretsmanager put-secret-value --secret-id <this> --secret-string \"$(head -c 32 /dev/urandom | base64)\""
  value       = aws_secretsmanager_secret.connector_key.arn
}

output "state_file_system_id" {
  description = "EFS filesystem holding state/config.json — the connector's sealed identity. Back it up together with the master key, or not at all: a snapshot without the key decrypts to nothing."
  value       = aws_efs_file_system.state.id
}

output "state_access_point_id" {
  description = "EFS access point pinning uid/gid 1000, which is what makes the mount writable by the container's non-root user."
  value       = aws_efs_access_point.state.id
}
