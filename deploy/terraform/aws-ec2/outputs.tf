output "instance_id" {
  description = "The connector host. Every command below needs it."
  value       = aws_instance.connector.id
}

# EICE tunnels ONLY ports 22 and 3389 — `--remote-port 9090` is accepted by the
# CLI and refused by AWS at the websocket upgrade ("InvalidParameter: The
# specified RemotePort is not valid"). So reaching the dashboard is two stages,
# in two shells. Measured; an earlier version of this output was a single wrong
# command.
output "open_dashboard_step1" {
  description = "Shell 1, leave running: EICE tunnel to SSH. Port 22 (or 3389) is all EICE will carry."
  value = join(" ", [
    "aws ec2-instance-connect open-tunnel",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--remote-port 22 --local-port 2222",
  ])
}

output "open_dashboard_step2" {
  description = "Shell 2, leave running: forward 9090 through that tunnel. Needs a key the instance accepts — see send_key. Then open http://localhost:9090/ (explicit http://: Chrome's HSTS on localhost can force https://, which the inspector does not serve). The host-side relay that bridges into the container's netns is installed by user-data as mcp-inspector-relay.service."
  value       = "ssh -i <key> -p 2222 -N -L 9090:127.0.0.1:9090 ec2-user@127.0.0.1"
}

output "send_key" {
  description = "Authorise a key for 60 seconds. EICE injects it; nothing is stored on the instance, which is why there is no key pair in this module. Mint a throwaway first: ssh-keygen -t ed25519 -N '' -f /tmp/eice_key"
  value = join(" ", [
    "aws ec2-instance-connect send-ssh-public-key",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--instance-os-user ec2-user",
    "--ssh-public-key file:///tmp/eice_key.pub",
  ])
}

output "ssh_in" {
  description = "An interactive shell, straight through EICE — no local tunnel needed, no inbound port from the internet. Note `aws ec2-instance-connect ssh` has NO --command flag: for non-interactive commands, use the step-1 tunnel plus plain ssh (see run_command)."
  value = join(" ", [
    "aws ec2-instance-connect ssh",
    "--region ${var.region}",
    "--instance-id ${aws_instance.connector.id}",
    "--connection-type eice",
  ])
}

output "run_command" {
  description = "Non-interactive command template. Needs open_dashboard_step1 running and a key sent. Read /var/log/mcp-connector-boot.log first if the container is not up, and /var/log/cloud-init-output.log if user-data itself failed."
  value       = "ssh -i <key> -p 2222 ec2-user@127.0.0.1 '<command>'"
}

output "check_boot" {
  description = "First-boot provisioning takes ~5-8 minutes (dnf, git clone, docker build). Run through the step-1 tunnel until it prints the container as running."
  value       = "ssh -i <key> -p 2222 ec2-user@127.0.0.1 'sudo tail -30 /var/log/mcp-connector-boot.log'"
}

output "doctor" {
  description = "The verification gate. Read the config-store line: 'will be created at boot' before Configure Tunnel, 'valid, key matches' after. The inspector-port FAIL is doctor probing the port the connector itself holds — a known self-detection quirk, not a deployment fault."
  value       = "ssh -i <key> -p 2222 ec2-user@127.0.0.1 'sudo sh -c \"cd /opt/mcp-shim/deploy/compose && docker compose -f docker-compose.prod.yml exec -T connector node dist/index.js doctor\"'"
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
