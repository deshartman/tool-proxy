output "instance_id" {
  description = "The connector host. Every command below needs it."
  value       = aws_instance.connector.id
}

output "open_dashboard" {
  description = "Forward the inspector to your laptop. The tunnel terminates ON the instance, so the connector sees a genuine loopback caller and the dashboard renders — a plain TCP forward to the host's port would answer 403. Leave this running, then open http://localhost:9090/ (explicit http://: Chrome's HSTS on localhost can force https://, which the inspector does not serve)."
  value = join(" ", [
    "aws ec2-instance-connect open-tunnel",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--remote-port 9090 --local-port 9090",
  ])
}

output "ssh_in" {
  description = "A shell on the box, via the same endpoint — no key material, no inbound port from the internet. Read /var/log/mcp-connector-boot.log first if the container is not up."
  value = join(" ", [
    "aws ec2-instance-connect ssh",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--connection-type eice",
  ])
}

output "check_boot" {
  description = "First-boot provisioning takes ~3-5 minutes (dnf, git clone, docker build). Run this until it prints the container as running."
  value = join(" ", [
    "aws ec2-instance-connect ssh",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--connection-type eice",
    "--command 'sudo tail -30 /var/log/mcp-connector-boot.log'",
  ])
}

output "doctor" {
  description = "The verification gate. Read the config-store line: 'will be created at boot' before Configure Tunnel, 'valid, key matches' after."
  value = join(" ", [
    "aws ec2-instance-connect ssh",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--connection-type eice",
    "--command 'cd /opt/mcp-shim/deploy/compose && sudo docker compose exec -T connector node dist/index.js doctor'",
  ])
}

output "no_inbound_surface" {
  description = "Confirm the outbound-only invariant: the instance SG must show exactly ONE ingress rule, on 22, sourced from the endpoint's security group and not a CIDR."
  value = join(" ", [
    "aws ec2 describe-security-groups",
    "--region ${var.region}",
    "--group-ids ${aws_security_group.instance.id}",
    "--query 'SecurityGroups[0].IpPermissions'",
  ])
}
