# ── Phase 1 outputs (available with deploy_connector = false) ───────────────

output "ecr_repository_url" {
  description = "Push the image here before the second apply."
  value       = aws_ecr_repository.connector.repository_url
}

output "build_and_push" {
  description = "Copy-paste build + push, from the repository root. Uses the same script CI uses, so local and CI images are built identically."
  value = join("\n", [
    "aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com",
    "IMAGE=${aws_ecr_repository.connector.repository_url}:${var.image_tag} PUSH=1 ./scripts/build-image.sh",
  ])
}

output "cluster_name" {
  description = "ECS cluster holding the connector service."
  value       = aws_ecs_cluster.main.name
}

# ── Phase 2 outputs (only once deploy_connector = true) ─────────────────────

output "service_name" {
  description = "ECS service name, or null before the connector is deployed."
  value       = try(module.connector[0].service_name, null)
}

output "put_master_key" {
  description = "Populate the ONE secret the connector needs. Run this before expecting a task to stay up — the key is minted by the command, never printed here."
  value = try(
    "aws secretsmanager put-secret-value --region ${var.region} --secret-id ${module.connector[0].connector_key_secret_arn} --secret-string \"$(head -c 32 /dev/urandom | base64)\"",
    null,
  )
}

output "open_dashboard" {
  description = "ECS Exec into the running task. This is the loopback hop that makes Configure Tunnel reachable; nothing else does. Fill in the TASK id from `aws ecs list-tasks`."
  value = try(
    join("\n", [
      "TASK=$(aws ecs list-tasks --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --service-name ${module.connector[0].service_name} --query 'taskArns[0]' --output text)",
      "aws ecs execute-command --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --task \"$TASK\" --container connector --interactive --command \"node dist/index.js doctor\"",
    ]),
    null,
  )
}

output "log_group_name" {
  description = "CloudWatch log group carrying the connector's stdout."
  value       = try(module.connector[0].log_group_name, null)
}

output "state_file_system_id" {
  description = "EFS filesystem holding state/config.json — the connector's sealed identity. Back it up together with the master key, or not at all: a snapshot without the key decrypts to nothing."
  value       = try(module.connector[0].state_file_system_id, null)
}
