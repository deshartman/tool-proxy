variable "connector_name" {
  description = "Names the AWS resources, and the value you will type into the inspector's Configure Tunnel modal. Not passed to the instance — identity is entered in the browser and sealed to disk."
  type        = string
}

variable "region" {
  description = "AWS region. The default VPC in this region is used."
  type        = string
}

variable "repo_url" {
  description = "Public git URL the instance clones at first boot. Must be PUBLIC: the instance has no credentials, deliberately — see the no-instance-profile note in main.tf."
  type        = string
  default     = "https://github.com/twilio-demos/conversation-agent-tool-sdk.git"
}

variable "repo_ref" {
  description = "Commit SHA or tag to check out. Pin a SHA for a reproducible instance; a branch name makes the deployed code depend on when the instance happened to boot."
  type        = string
  default     = "main"
}

variable "instance_type" {
  description = "t3.small (2 GB) is the floor. The connector plus its four bundled MCPs measure 493 MB, and each Type 1 child is three processes (tsx wrapper, real node, resident esbuild) — but the OS, Docker and the image build also need room. t3.micro's 1 GB will OOM during `docker build`."
  type        = string
  default     = "t3.small"

  validation {
    condition     = !can(regex("(nano|micro)$", var.instance_type))
    error_message = "t3.nano/t3.micro cannot build the image or run the four bundled MCPs. Use t3.small or larger."
  }
}

variable "root_volume_gb" {
  description = "Root EBS size. The image is ~350 MB, the build needs scratch, and Docker's layer cache grows. 20 GB is comfortable; 8 (the AMI default) is not."
  type        = number
  default     = 20
}

variable "subnet_id" {
  description = "Subnet for the instance. Empty picks the first subnet of the region's default VPC, which is what makes this module runnable with no prior AWS setup."
  type        = string
  default     = ""
}
