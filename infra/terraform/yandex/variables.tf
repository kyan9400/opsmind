# --- Yandex Cloud ------------------------------------------------------------

variable "cloud_id" {
  description = "Yandex Cloud ID (`yc config get cloud-id`)."
  type        = string
}

variable "folder_id" {
  description = "Folder ID the resources are created in (`yc config get folder-id`)."
  type        = string
}

variable "zone" {
  description = "Availability zone for the subnet, static IP and VM."
  type        = string
  default     = "ru-central1-a"

  validation {
    condition     = contains(["ru-central1-a", "ru-central1-b", "ru-central1-d"], var.zone)
    error_message = "zone must be one of ru-central1-a, ru-central1-b, ru-central1-d."
  }
}

variable "service_account_key_file" {
  description = "Path to (or JSON content of) a service account authorized key. Null means use YC_TOKEN from the environment."
  type        = string
  default     = null
  sensitive   = true
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "opsmind"
}

# --- Access -------------------------------------------------------------------

variable "ssh_public_key" {
  description = "Your SSH public key (contents of ~/.ssh/id_ed25519.pub), installed for the deploy user."
  type        = string
}

variable "extra_ssh_public_keys" {
  description = "Additional public keys for the deploy user, e.g. a dedicated key for the GitHub Actions deploy job."
  type        = list(string)
  default     = []
}

variable "admin_cidr" {
  description = "Only this CIDR may reach SSH, e.g. \"203.0.113.7/32\" for your home IP."
  type        = string

  validation {
    condition     = can(cidrhost(var.admin_cidr, 0))
    error_message = "admin_cidr must be a valid IPv4 CIDR such as 203.0.113.7/32."
  }
}

variable "ci_ssh_cidrs" {
  description = "Extra CIDRs allowed to SSH, for the GitHub Actions deploy job. GitHub-hosted runners have no fixed IPs, so that means [\"0.0.0.0/0\"]; leave empty to deploy by hand or from a self-hosted runner."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.ci_ssh_cidrs : can(cidrhost(c, 0))])
    error_message = "ci_ssh_cidrs must contain valid IPv4 CIDRs."
  }
}

variable "deploy_user" {
  description = "Non-root Linux user that owns the checkout and runs docker compose."
  type        = string
  default     = "deploy"
}

# --- VM size ------------------------------------------------------------------

variable "platform_id" {
  description = "Compute platform (standard-v3 = Intel Ice Lake)."
  type        = string
  default     = "standard-v3"
}

variable "cores" {
  description = "vCPU count."
  type        = number
  default     = 2
}

variable "memory" {
  description = "RAM in GB. The Next.js build is the peak; 4 GB plus swap is comfortable."
  type        = number
  default     = 4
}

variable "core_fraction" {
  description = "Guaranteed vCPU share in percent. Lower is cheaper; builds just take longer."
  type        = number
  default     = 50

  validation {
    condition     = contains([20, 50, 100], var.core_fraction)
    error_message = "core_fraction must be 20, 50 or 100 on standard-v3."
  }
}

variable "disk_size" {
  description = "Boot disk size in GB (images, build cache, Postgres data)."
  type        = number
  default     = 30
}

variable "disk_type" {
  description = "Boot disk type: network-hdd (cheapest) or network-ssd."
  type        = string
  default     = "network-ssd"
}

variable "preemptible" {
  description = "Preemptible VMs cost roughly a third but are stopped at least once every 24h and on capacity pressure."
  type        = bool
  default     = true
}

variable "swap_size" {
  description = "Swap file size; keeps image builds from being OOM-killed on small VMs."
  type        = string
  default     = "2G"
}

# --- Application ------------------------------------------------------------

variable "repo_url" {
  description = "Git URL cloned onto the VM. Must be readable without credentials."
  type        = string
  default     = "https://github.com/kyan9400/opsmind.git"
}

variable "repo_branch" {
  description = "Branch checked out on first boot."
  type        = string
  default     = "main"
}

variable "domain" {
  description = "Public hostname. Empty means <ip-with-dashes>.sslip.io, which needs no DNS setup."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.domain))
    error_message = "domain must be a bare lowercase hostname without scheme or path."
  }
}

variable "docker_registry_mirror" {
  description = "Pull-through registry mirror for Docker Hub; Docker Hub rate-limits and is unreliable from some regions. Empty disables it."
  type        = string
  default     = "https://mirror.gcr.io"
}

variable "postgres_user" {
  description = "Postgres role used by the app."
  type        = string
  default     = "opsmind"
}

variable "postgres_db" {
  description = "Postgres database name."
  type        = string
  default     = "opsmind"
}

# Secrets default to null and are generated by Terraform; set them only to reuse existing values.
# Character sets are restricted because the values end up in a URL and a .env file.

variable "postgres_password" {
  description = "Postgres password. Null generates one."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{16,}$", coalesce(var.postgres_password, "generated-by-terraform")))
    error_message = "postgres_password must be at least 16 characters of [A-Za-z0-9_-]."
  }
}

variable "jwt_secret" {
  description = "API JWT signing secret. Null generates one."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_.~+/=-]{32,}$", coalesce(var.jwt_secret, "generated-by-terraform-generated-by-terraform")))
    error_message = "jwt_secret must be at least 32 characters of [A-Za-z0-9_.~+/=-]."
  }
}

variable "ai_service_token" {
  description = "Shared token between the API/worker and the AI service. Null generates one."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_.~-]{16,}$", coalesce(var.ai_service_token, "generated-by-terraform")))
    error_message = "ai_service_token must be at least 16 characters of [A-Za-z0-9_.~-]."
  }
}

variable "embed_provider" {
  description = "Embeddings provider: hash (offline), openai or ollama."
  type        = string
  default     = "hash"

  validation {
    condition     = contains(["hash", "openai", "ollama"], var.embed_provider)
    error_message = "embed_provider must be hash, openai or ollama."
  }
}

variable "llm_provider" {
  description = "Answer provider: extractive (offline), openai, anthropic or ollama."
  type        = string
  default     = "extractive"

  validation {
    condition     = contains(["extractive", "openai", "anthropic", "ollama"], var.llm_provider)
    error_message = "llm_provider must be extractive, openai, anthropic or ollama."
  }
}

variable "openai_api_key" {
  description = "Required when either provider is openai."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]*$", var.openai_api_key))
    error_message = "openai_api_key contains unexpected characters."
  }
}

variable "anthropic_api_key" {
  description = "Required when llm_provider is anthropic."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]*$", var.anthropic_api_key))
    error_message = "anthropic_api_key contains unexpected characters."
  }
}
