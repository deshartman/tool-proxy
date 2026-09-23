variable "connector_name" {
  description = "Names every resource this creates, and the value you will type into the inspector's Configure Tunnel modal. Must match the controller's Tunnel Security row Name exactly (case-sensitive) — but it is NOT passed to the container, so a mismatch is fixed in the browser, not here."
  type        = string
}

variable "region" {
  description = "AWS region. Everything lands here."
  type        = string
}

# ── The two-phase gate ──────────────────────────────────────────────────────
#
# There is a genuine ordering problem in a from-zero deploy: the ECS service
# cannot start until an image exists in ECR, and the ECR repository does not
# exist until Terraform has run. A single `apply` creates both, and the first
# tasks then die with CannotPullContainerError — which reads like a broken
# connector rather than an empty registry.
#
# So: apply once with this false to get the registry and the network, push the
# image, then apply again with the default.
variable "deploy_connector" {
  description = "false on the first apply (foundation + ECR only, so you have somewhere to push the image); true on the second (adds EFS, the secret, the task definition and the service)."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "Image tag to run. Never `latest` — a task restart would become an unplanned upgrade of a process whose whole job is holding one long-lived socket."
  type        = string
  default     = "0.1.0"

  validation {
    condition     = var.image_tag != "latest"
    error_message = "image_tag must not be 'latest'. Pin a version so a restart is not an upgrade."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the VPC this creates. Change it if it would collide with something you peer to."
  type        = string
  default     = "10.42.0.0/16"
}

variable "ecr_force_delete" {
  description = "Let `terraform destroy` delete the ECR repository even when it still holds images. Left false so a destroy cannot silently discard them; flip it when you actually want the teardown to be one command."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch retention for the connector's stdout."
  type        = number
  default     = 30
}
