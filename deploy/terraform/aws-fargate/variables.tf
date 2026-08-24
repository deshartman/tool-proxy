variable "connector_name" {
  description = "CONNECTOR_NAME — must exactly match the controller's Tunnel Security row Name (case-sensitive)."
  type        = string
}

variable "controller_url" {
  description = "HTTPS root of the controller. The connector upgrades this to wss:// internally."
  type        = string
}

variable "image" {
  description = "OCI image reference for the connector."
  type        = string
  default     = "ghcr.io/twilio/mcp-connector:latest"
}

variable "cluster_arn" {
  description = "ARN of an existing ECS cluster the task will run in."
  type        = string
}

variable "task_role_arn" {
  description = "ARN of the ECS task role (grants access to Secrets Manager, CloudWatch)."
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the ECS task execution role (image pulls + secret injection)."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets the service places tasks in. Must have outbound TLS 443 egress."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group allowing egress to CONTROLLER_URL:443. No inbound rules needed."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the task's stdout."
  type        = number
  default     = 30
}

variable "region" {
  description = "AWS region used for the CloudWatch log group's awslogs-region option."
  type        = string
}
