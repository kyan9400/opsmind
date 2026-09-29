# Deploying OpsMind

> **Optional.** OpsMind is not hosted permanently; to try it, use the one-click [Codespaces demo](../.devcontainer/README.md). Everything below is ready for anyone who wants their own server. Until the deploy secrets are set, the deploy workflow skips itself with a notice.

One small VM runs the whole stack with Docker Compose. Caddy is the only public entrypoint and gets a free HTTPS certificate automatically.

```
internet ──443/80──► Caddy ──/api/*, /health, /ready──► api:4000 ──► postgres, redis, ai
                        └────────── everything else ──► web:3000
```

- `terraform/yandex/` creates the VM on **Yandex Cloud** (network, firewall, static IP, VM, first-boot setup).
- `../docker-compose.prod.yml` + `../deploy/caddy/Caddyfile` work on **any Ubuntu 22.04 / 24.04 server**, with or without Terraform.
- `../.github/workflows/deploy.yml` redeploys automatically after CI passes on `main`, once the secrets from step 7 are set.

Without a domain, the app is served at `https://<ip-with-dashes>.sslip.io` (for example `https://203-0-113-7.sslip.io`). [sslip.io](https://sslip.io) is a public DNS service that maps that name to the IP, so HTTPS works with zero DNS setup.

---

## Option A: Yandex Cloud with Terraform

### 1. Create an account and a folder

1. Sign up at <https://console.yandex.cloud> and create a **billing account**. New users get a starter grant (check the current amount and validity in the console), which covers this VM for a while.
2. The console creates a cloud and a `default` folder for you. You can use it, or create a new folder called `opsmind`.
3. Copy the **cloud ID** and the **folder ID** (shown on the folder page, they look like `b1g...`).

### 2. Install the tools

- **Terraform** 1.6 or newer. If `releases.hashicorp.com` does not open from your network, download it from the Yandex mirror: <https://hashicorp-releases.yandexcloud.net/terraform/>.
- **Yandex Cloud CLI** (`yc`): <https://yandex.cloud/en/docs/cli/quickstart>.

The Terraform Registry also blocks some regions. If `terraform init` cannot download providers, create `~/.terraformrc` (Windows: `%APPDATA%\terraform.rc`) with:

```hcl
provider_installation {
  network_mirror {
    url     = "https://terraform-mirror.yandexcloud.net/"
    include = ["registry.terraform.io/*/*"]
  }
  direct {
    exclude = ["registry.terraform.io/*/*"]
  }
}
```

### 3. Log in

Pick one:

**Your own account (simplest).** Run `yc init`, open the OAuth link it prints, paste the token back, and choose your cloud and folder. Then get a short-lived IAM token (valid 12 hours):

```bash
export YC_TOKEN=$(yc iam create-token)          # bash
$env:YC_TOKEN = (yc iam create-token)           # PowerShell
```

**A service account (better for automation).**

```bash
yc iam service-account create --name opsmind-terraform
yc resource-manager folder add-access-binding <folder-id> \
  --role editor --subject serviceAccount:$(yc iam service-account get opsmind-terraform --format json | jq -r .id)
yc iam key create --service-account-name opsmind-terraform --output ~/.yc/opsmind-sa-key.json
```

Then set `service_account_key_file = "~/.yc/opsmind-sa-key.json"` in `terraform.tfvars`. Keep that file private: it is a password.

### 4. Configure

```bash
cd infra/terraform/yandex
cp terraform.tfvars.example terraform.tfvars
```

Fill in at least `cloud_id`, `folder_id`, `ssh_public_key` (the content of `~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if needed) and `admin_cidr` (your public IP plus `/32`; find it with `curl https://ifconfig.me`).

Database password, JWT secret and the internal AI token are **generated for you**. The app starts with the offline AI providers; add `openai_api_key` / `anthropic_api_key` and switch `embed_provider` / `llm_provider` when you want real models.

### 5. Create everything

```bash
terraform init
terraform plan      # read it: 1 network, 1 subnet, 1 security group, 1 IP, 1 VM, 3 random secrets
terraform apply
```

When it finishes it prints `app_url`, `public_ip` and `ssh_command`. The VM needs **about 10 minutes** on first boot: it installs Docker, clones the repo, builds the images and requests the certificate. Watch it with:

```bash
ssh deploy@<public_ip> 'sudo tail -f /var/log/cloud-init-output.log'
```

Then open `app_url` and register the first workspace.

### 6. Use your own domain (optional)

1. At your DNS provider, create an **A record**, e.g. `opsmind.example.com → <public_ip>`. Wait until `nslookup opsmind.example.com` returns that IP.
2. Set `domain = "opsmind.example.com"` in `terraform.tfvars` and run `terraform apply` (this only updates the outputs; the VM is not recreated).
3. On the VM, update the running app (the web bundle has the URL built in, hence `--build`):

   ```bash
   ssh deploy@<public_ip>
   cd /opt/opsmind
   sed -i 's/^DOMAIN=.*/DOMAIN=opsmind.example.com/' .env
   docker compose up -d --build
   ```

   (`COMPOSE_FILE` in `.env` makes plain `docker compose` use the production override.)

### 7. Turn on automatic deploys (optional)

After each green CI run on `main`, `.github/workflows/deploy.yml` SSHes into the VM, checks out exactly the tested commit, rebuilds and waits for `https://<domain>/ready`. Without the secrets below it is skipped with a notice, so forks stay green.

1. Make a key just for CI: `ssh-keygen -t ed25519 -f opsmind-deploy -N "" -C github-actions`.
2. In `terraform.tfvars` add `extra_ssh_public_keys = ["<content of opsmind-deploy.pub>"]`.
3. GitHub-hosted runners have no fixed IP range, so SSH must be reachable from anywhere: add `ci_ssh_cidrs = ["0.0.0.0/0"]`. Password login is disabled and fail2ban is on, so only key holders get in. If you don't want that, skip this step and deploy by hand, or use a self-hosted runner.
4. Run `terraform apply`. The security group changes in place. The new key only reaches a VM created from now on; for the existing VM, append it yourself: `ssh deploy@<ip> 'cat >> ~/.ssh/authorized_keys' < opsmind-deploy.pub`.
5. In GitHub, **Settings → Secrets and variables → Actions**, add:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | `terraform output -raw public_ip` |
   | `DEPLOY_SSH_KEY` | content of the private key file `opsmind-deploy` |
   | `DEPLOY_USER` | optional, default `deploy` |
   | `DEPLOY_HOST_FINGERPRINT` | optional but recommended: `ssh-keyscan -t ed25519 <ip> \| ssh-keygen -lf -` (the `SHA256:...` part) |

You can also run it by hand from the **Actions → Deploy → Run workflow** button.

### What it costs

Rough monthly prices for the default size (2 vCPU at 50%, 4 GB RAM, 30 GB SSD, static IP), before VAT. Prices change, so check the [pricing calculator](https://yandex.cloud/en/prices).

| | Preemptible (default) | Regular |
|---|---|---|
| VM (CPU + RAM) | ~700 ₽ | ~1,900 ₽ |
| 30 GB network SSD | ~350 ₽ | ~350 ₽ |
| Static public IP | ~150 ₽ | ~150 ₽ |
| **Total** | **~1,200 ₽** | **~2,400 ₽** |

Ways to spend less: `disk_type = "network-hdd"` (about a quarter of the SSD price, slower builds) and `core_fraction = 20`. Outgoing traffic is free up to a monthly allowance, which a demo won't reach.

**Preemptible** means Yandex may stop the VM at any time, and does so at least once every 24 hours. The data and the IP are kept; the VM just stays **stopped** until you start it again:

```bash
yc compute instance start opsmind-app
```

The stack comes back by itself after boot (a systemd unit runs `docker compose up`). For an always-on demo set `preemptible = false`.

### Tear it all down

```bash
terraform destroy
```

This deletes the VM **with the database on its disk**, the IP and the network. Billing stops right away. Keep a dump first if you need the data:

```bash
ssh deploy@<ip> 'cd /opt/opsmind && docker compose exec -T postgres pg_dump -U opsmind opsmind' > opsmind.sql
```

### Good to know

- **Secrets live in two places:** the Terraform state (`terraform.tfstate`, git-ignored, keep it safe) and the VM's user-data, which folder members can see in the console. Containers are firewalled off from the metadata service so a compromised app cannot read it.
- **State is local.** For a team, switch to the Object Storage backend commented out in `versions.tf`.
- **Changing variables later** does not reconfigure a running VM: cloud-init only runs once, and Terraform deliberately ignores user-data and newer Ubuntu images so it never recreates the VM by surprise. Edit `/opt/opsmind/.env` on the VM instead, or rebuild on purpose with `terraform apply -replace=yandex_compute_instance.app` (this wipes the database).
- **Backups are not set up.** For anything beyond a demo, schedule `pg_dump` to Object Storage or move Postgres to Managed PostgreSQL.
- **Rate limits see real client IPs.** `docker-compose.prod.yml` sets `TRUST_PROXY=1` for Caddy, so login/register attempts are limited per IP (20 per 15 minutes) and questions, insights and report exports per user and IP (20 per minute, with a ceiling of 10× that per account). Change them with `AUTH_RATE_LIMIT` / `AI_RATE_LIMIT` in `.env` (0 disables) and run `docker compose up -d`.
- **A public demo login** is one command on the VM: `cd /opt/opsmind && docker compose exec -e DEMO_EMAIL=demo@example.com -e DEMO_PASSWORD='choose-one' api node dist/seedDemo.js`. It creates a read-only viewer in a sample workspace; see "Demo workspace" in the [main README](../README.md#demo-workspace).

---

## Option B: any Ubuntu 22.04 / 24.04 server

Any VPS with 2 vCPU / 4 GB RAM and ports 80 and 443 open works.

```bash
# Docker Engine + compose plugin from Docker's repo (Ubuntu's docker.io is too old for `!reset`)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /opt/opsmind && sudo chown $USER /opt/opsmind
git clone https://github.com/kyan9400/opsmind.git /opt/opsmind && cd /opt/opsmind

IP=$(curl -s https://ifconfig.me)
cat > .env <<EOF
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
DOMAIN=${IP//./-}.sslip.io
POSTGRES_USER=opsmind
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=opsmind
JWT_SECRET=$(openssl rand -hex 32)
AI_SERVICE_TOKEN=$(openssl rand -hex 24)
EMBED_PROVIDER=hash
LLM_PROVIDER=extractive
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
EOF
chmod 600 .env

docker compose up -d --build
curl -fsS https://$(grep ^DOMAIN= .env | cut -d= -f2)/ready
```

The containers restart on their own after a crash or reboot (`restart: unless-stopped`). Only Caddy publishes ports; Postgres, Redis, the API, the AI service and `/metrics` are not reachable from outside.
