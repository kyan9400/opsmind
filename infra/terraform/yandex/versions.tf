terraform {
  required_version = ">= 1.6"

  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "~> 0.140"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State stays local by default: a single-VM demo does not justify a bucket, and the
  # state holds the generated app secrets, so keep it out of git (see infra/.gitignore).
  #
  # For a shared or long-lived setup, move it to Object Storage (S3-compatible). Create
  # the bucket and a static access key first, export AWS_ACCESS_KEY_ID /
  # AWS_SECRET_ACCESS_KEY, then uncomment and run `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   endpoints = {
  #     s3 = "https://storage.yandexcloud.net"
  #   }
  #   bucket = "opsmind-tfstate"
  #   key    = "yandex/terraform.tfstate"
  #   region = "ru-central1"
  #
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  # }
}

provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
  zone      = var.zone

  # Leave null to authenticate with the YC_TOKEN environment variable instead.
  service_account_key_file = var.service_account_key_file
}
