output "public_ip" {
  description = "Static public IPv4 of the VM. Use it as the DEPLOY_HOST GitHub secret."
  value       = local.public_ip
}

output "app_url" {
  description = "Public URL. The first boot needs about 10 minutes (packages, image build, TLS certificate)."
  value       = "https://${local.domain}"
}

output "ssh_command" {
  description = "SSH into the VM as the deploy user."
  value       = "ssh ${var.deploy_user}@${local.public_ip}"
}
