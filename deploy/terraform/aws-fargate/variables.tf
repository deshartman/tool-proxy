# Names the AWS resources this module creates (log group, secret, EFS, task
# family, service). It is NOT passed to the container: CONNECTOR_NAME was
# retired by ENV-TO-DB and the connector name is typed into the inspector's
# Configure Tunnel modal. Keep them the same anyway — an operator debugging at
# 3am should not have to map one to the other.
variable "connector_name" {
  description = "Name suffix for the AWS resources. Use the same value you will enter in Configure Tunnel (which must match the controller's Tunnel Security row Name, case-sensitive)."
  type        = string
}

# `controller_url` was removed rather than kept as an ignored input. CONTROLLER_URL
# is retired — the URL is entered in the inspector's Configure Tunnel modal and
# sealed into the state volume. An input that no resource reads is how the Helm
# chart ended up `required`ing four dead values, so it is deleted, not defaulted.
# Callers still passing it get an "argument not expected here" error, which is
# the correct, loud failure.

variable "vpc_id" {
  description = "VPC the EFS mount targets and their security group live in. Must be the VPC containing subnet_ids."
  type        = string
}

variable "task_cpu" {
  description = "Fargate CPU units. 256 is the cheapest valid pairing that clears the memory floor, but a quarter vCPU is thin for five node processes plus esbuild."
  type        = string
  default     = "512"
}

variable "task_memory" {
  description = "Fargate memory in MiB. The measured floor is 493 MB for the connector plus four bundled MCPs; 512 cannot boot the shipped image at all. Do not lower below 1024."
  type        = string
  default     = "2048"

  validation {
    # A number below the measured floor produces the fourth MCP child dying at
    # its readiness probe with no output, which reads as a broken MCP rather
    # than an undersized task. Fail at plan time instead.
    condition     = tonumber(var.task_memory) >= 1024
    error_message = "task_memory must be at least 1024 MiB; the connector plus its bundled MCPs measure 493 MB and a 512 MiB task cannot boot the image."
  }
}

variable "assign_public_ip" {
  description = "Whether the task gets a public IP. TRUE unless subnet_ids route egress through a NAT gateway: outbound-only does not mean no-egress-needed, and with no route out the task cannot pull from ECR and dies with CannotPullContainerError before any connector code runs. Nothing reaches the connector inbound either way — that is enforced by the security group having no ingress rules and by there being no load balancer."
  type        = bool
  default     = true
}

variable "image" {
  description = "OCI image reference for the connector."
  type        = string
  default     = "ghcr.io/twilio/tool-proxy:latest"
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
  description = "Subnets the service places tasks in. Must have outbound TLS 443 egress. An EFS mount target is created in each one — omitting a subnet the task can land in makes the mount fail in that AZ only, which presents as a flaky deploy."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group for the task. Needs egress on 443 (controller, ECR, Secrets Manager) and 2049 (EFS). No inbound rules — that is the outbound-only invariant."
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
