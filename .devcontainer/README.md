# OpsMind in GitHub Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/kyan9400/opsmind?quickstart=1)

A codespace runs the whole stack (Postgres + pgvector, Redis, API, worker, AI service and the web app)
with Docker-in-Docker, seeds a demo workspace and opens the web app in a new browser tab.

- **The first start takes a few minutes** while the images are built; progress shows in the terminal.
  Restarting a stopped codespace reuses them and is much quicker.
- **Sign in** with **Try the live demo**, or `demo@opsmind.dev` / `opsmind-demo`. It is a read-only
  viewer in a sample company: browse the KPIs and anomalies, ask questions about its documents, export
  reports. To try uploads and user management, register your own workspace on the sign-in page.
- **AI-backed requests are rate-limited**: questions, insights and report exports share a budget of 20
  per minute for the demo login. If you hit it, wait a minute, or lift it for your codespace with
  `AI_RATE_LIMIT=0 bash .devcontainer/start.sh`.
- **It runs on your own Codespaces quota** (personal accounts get a free monthly allowance) on the
  smallest 2-core machine. Nothing is billed to the repository owner.
- **Stop it** when you are done: from [github.com/codespaces](https://github.com/codespaces), or let it
  stop itself after the idle timeout (30 minutes by default). Delete the codespace to free its storage.
  `docker compose down` inside the codespace stops just the app; `bash .devcontainer/start.sh` brings it back.

## How it works

| File | Role |
| --- | --- |
| `devcontainer.json` | Ubuntu 24.04 base image (pinned: the floating `ubuntu` tag moved to a release the Docker-in-Docker feature could not install on) + Docker-in-Docker; forwards 3000 (web) and 4000 (API). Builds the images on create, runs `start.sh` on every start. |
| `docker-compose.codespaces.yml` | Overlay on the root `docker-compose.yml`. Codespaces gives each port its own GitHub-authenticated URL, so the browser calls `/api/v1` on the web app's own origin and the Next.js server proxies it to `http://api:4000`. Also bakes in the demo login for the button. |
| `start.sh` | Backend up, demo seeded, web up, a sign-in through the proxy as a check, then the URL. Idempotent, and it works on any machine with Docker: `bash .devcontainer/start.sh`. |

CI covers both halves in two jobs:

- **`codespace`** runs `start.sh` straight on the runner, twice (a restarted codespace must come back
  cleanly). It then signs in to the demo, runs the smoke test, clicks the one-click demo in a real
  browser and runs the Playwright browser suite, all through the web app's same-origin proxy.
- **`devcontainer`** boots this dev container end to end, the way Codespaces does: `postCreateCommand`
  builds the images and `postStartCommand` starts and seeds the stack. It then checks that the web app
  serves the demo button.
