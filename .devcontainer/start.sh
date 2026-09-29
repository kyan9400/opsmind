#!/usr/bin/env bash
# Starts the full OpsMind stack for the Codespaces demo. It only needs Docker, so it also runs on any
# dev machine, and CI runs it as-is.
#
#   bash .devcontainer/start.sh               build if needed, start, seed the demo, print the URL
#   bash .devcontainer/start.sh --build-only  build the images only (postCreateCommand)
#
# Idempotent: compose only recreates what changed and the demo seed refreshes in place, which is what
# lets postStartCommand bring a stopped codespace back up.
set -euo pipefail

cd "$(dirname "$0")/.."

# Must match the web build args; docker-compose.codespaces.yml reads these same variables.
export DEMO_EMAIL="${DEMO_EMAIL:-demo@opsmind.dev}"
export DEMO_PASSWORD="${DEMO_PASSWORD:-opsmind-demo}"
WEB=http://localhost:3000

compose() { docker compose -f docker-compose.yml -f .devcontainer/docker-compose.codespaces.yml "$@"; }

# docker-in-docker starts its daemon alongside the lifecycle commands, so the first call can race it.
for attempt in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  if [ "$attempt" -eq 60 ]; then
    echo "Docker is not reachable after 2 minutes" >&2
    exit 1
  fi
  sleep 2
done

if [ "${1:-}" = "--build-only" ]; then
  compose pull --quiet postgres redis
  compose build
  exit 0
fi

# Backend first and seeded before the web app starts: Codespaces opens the browser as soon as port 3000
# listens, and "Try the live demo" has to work on the first click.
compose up -d --build --wait --wait-timeout 300 postgres redis api ai worker
compose exec -T -e DEMO_EMAIL -e DEMO_PASSWORD api node dist/seedDemo.js
compose up -d --build web

# The web image has no healthcheck. Wait for Next.js, then sign in through its /api proxy: that is the
# exact path the browser takes (web -> proxy -> API -> Postgres) and proves the seeded login works.
curl -fsS --retry 60 --retry-delay 2 --retry-all-errors -o /dev/null "$WEB/login"
# No -f and no --retry-all-errors: a 401 must not be retried (it spends the login rate limit), and its
# body is the useful error message. Proxy errors (5xx) while the API warms up are still retried.
login=$(curl -sS --retry 5 --retry-delay 2 --retry-connrefused -X POST "$WEB/api/v1/auth/login" \
  -H 'content-type: application/json' -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\"}")
if ! grep -q '"token"' <<<"$login"; then
  echo "Demo sign-in through the web app's /api proxy failed: $login" >&2
  exit 1
fi

if [ -n "${CODESPACE_NAME:-}" ]; then
  url="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  url=$WEB
fi

cat <<EOF

  OpsMind is running:  $url
  Demo sign-in:        $DEMO_EMAIL / $DEMO_PASSWORD  (read-only viewer)
                       or click "Try the live demo" on the home page
  Stop the app:        docker compose down

EOF
