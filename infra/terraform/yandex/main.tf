data "yandex_compute_image" "ubuntu" {
  family = "ubuntu-2204-lts"
}

# Secrets are generated once and live only in Terraform state and the VM's .env,
# never in tfvars or git.
resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "random_password" "ai_token" {
  length  = 32
  special = false
}

locals {
  public_ip = yandex_vpc_address.public.external_ipv4_address[0].address

  # sslip.io resolves 1-2-3-4.sslip.io to 1.2.3.4, so Let's Encrypt works before any DNS exists.
  domain = var.domain != "" ? var.domain : "${replace(local.public_ip, ".", "-")}.sslip.io"

  # Values are single-quoted so compose never interpolates them; the variable validations
  # guarantee they contain no quotes.
  env_file = <<-EOT
    # Written by cloud-init from Terraform. Edit on the VM, then:
    #   docker compose up -d
    COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
    DOMAIN=${local.domain}
    POSTGRES_USER=${var.postgres_user}
    POSTGRES_PASSWORD='${coalesce(var.postgres_password, random_password.postgres.result)}'
    POSTGRES_DB=${var.postgres_db}
    JWT_SECRET='${coalesce(var.jwt_secret, random_password.jwt.result)}'
    AI_SERVICE_TOKEN='${coalesce(var.ai_service_token, random_password.ai_token.result)}'
    EMBED_PROVIDER=${var.embed_provider}
    LLM_PROVIDER=${var.llm_provider}
    OPENAI_API_KEY='${var.openai_api_key}'
    ANTHROPIC_API_KEY='${var.anthropic_api_key}'
    LLM_BASE_URL='${var.llm_base_url}'
    LLM_MODEL='${var.llm_model}'
    LLM_API_KEY='${var.llm_api_key}'
  EOT
}

resource "yandex_vpc_network" "main" {
  name = "${var.name}-net"
}

resource "yandex_vpc_subnet" "main" {
  name           = "${var.name}-subnet-${var.zone}"
  zone           = var.zone
  network_id     = yandex_vpc_network.main.id
  v4_cidr_blocks = ["10.10.0.0/24"]
}

resource "yandex_vpc_security_group" "app" {
  name        = "${var.name}-app"
  description = "SSH from the admin CIDR only; HTTP(S) from anywhere. Everything else is dropped."
  network_id  = yandex_vpc_network.main.id

  ingress {
    description    = "SSH (admin only)"
    protocol       = "TCP"
    port           = 22
    v4_cidr_blocks = [var.admin_cidr]
  }

  # Opt-in: GitHub-hosted runners come from ever-changing ranges. Key-only auth and fail2ban
  # make a world-open port 22 acceptable for a demo; a self-hosted runner avoids it entirely.
  dynamic "ingress" {
    for_each = length(var.ci_ssh_cidrs) > 0 ? [1] : []
    content {
      description    = "SSH (CI deploy)"
      protocol       = "TCP"
      port           = 22
      v4_cidr_blocks = var.ci_ssh_cidrs
    }
  }

  # Port 80 must stay open: Caddy answers the ACME HTTP-01 challenge and redirects to HTTPS.
  ingress {
    description    = "HTTP"
    protocol       = "TCP"
    port           = 80
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description    = "HTTPS"
    protocol       = "TCP"
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description    = "HTTP/3 (QUIC)"
    protocol       = "UDP"
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description    = "All outbound (apt, image pulls, git, LLM APIs, ACME)"
    protocol       = "ANY"
    from_port      = 0
    to_port        = 65535
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

# A reserved address survives VM stop/start and preemption, so the sslip.io hostname,
# the TLS certificate and the DEPLOY_HOST secret stay valid.
resource "yandex_vpc_address" "public" {
  name = "${var.name}-ip"

  external_ipv4_address {
    zone_id = var.zone
  }
}

resource "yandex_compute_instance" "app" {
  name                      = "${var.name}-app"
  hostname                  = "${var.name}-app"
  platform_id               = var.platform_id
  zone                      = var.zone
  allow_stopping_for_update = true

  resources {
    cores         = var.cores
    memory        = var.memory
    core_fraction = var.core_fraction
  }

  boot_disk {
    initialize_params {
      image_id = data.yandex_compute_image.ubuntu.id
      size     = var.disk_size
      type     = var.disk_type
    }
  }

  network_interface {
    subnet_id          = yandex_vpc_subnet.main.id
    nat                = true
    nat_ip_address     = local.public_ip
    security_group_ids = [yandex_vpc_security_group.app.id]
  }

  scheduling_policy {
    preemptible = var.preemptible
  }

  metadata = {
    user-data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      deploy_user            = var.deploy_user
      ssh_public_keys        = concat([var.ssh_public_key], var.extra_ssh_public_keys)
      repo_url               = var.repo_url
      repo_branch            = var.repo_branch
      env_file               = local.env_file
      swap_size              = var.swap_size
      docker_registry_mirror = var.docker_registry_mirror
    })
  }

  lifecycle {
    # Without both, the AI service would answer every question with the offline fallback.
    precondition {
      condition     = var.llm_provider != "openai-compatible" || (var.llm_base_url != "" && var.llm_model != "")
      error_message = "llm_provider = \"openai-compatible\" needs llm_base_url and llm_model."
    }

    ignore_changes = [
      # The image family moves to a newer build every few weeks; without this every plan
      # would want to recreate the VM and wipe the Postgres volume on its disk.
      boot_disk[0].initialize_params[0].image_id,
      # cloud-init only runs on first boot, so later edits would be a no-op anyway.
      # Change config on the VM, or rebuild on purpose with `terraform apply -replace`.
      metadata["user-data"],
    ]
  }
}
