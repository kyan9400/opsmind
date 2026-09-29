#!/usr/bin/env bash
# Publishes the static interactive preview (apps/web/out) to SourceCraft Sites.
#
#   SOURCECRAFT_TOKEN=<personal access token> SOURCECRAFT_REPO=<org>/<repo> bash deploy/sourcecraft/publish.sh apps/web/out
#
# SourceCraft reads .sourcecraft/sites.yaml from the repository's main (default) branch; its `ref` names
# the branch whose files are served, at https://<org>.sourcecraft.site/<repo>/. So the built site goes to
# its own branch (SOURCECRAFT_SITE_BRANCH, default "site"), replaced by one fresh commit on every run, and
# the default branch only holds the config and a README. The SourceCraft repository is a publish target,
# not a mirror. Outside GitHub Actions, SOURCECRAFT_GIT_URL overrides the remote (e.g. a local bare
# repository to rehearse a publish).
set -euo pipefail

out="${1:?usage: publish.sh <static site dir>}"
: "${SOURCECRAFT_TOKEN:?set SOURCECRAFT_TOKEN (a SourceCraft personal access token)}"
: "${SOURCECRAFT_REPO:?set SOURCECRAFT_REPO (<organization>/<repository>, as in the SourceCraft URL)}"
[[ "$SOURCECRAFT_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  { echo "SOURCECRAFT_REPO must be <organization>/<repository>, got '$SOURCECRAFT_REPO'" >&2; exit 1; }
site_branch="${SOURCECRAFT_SITE_BRANCH:-site}"
sourcecraft_host="git.sourcecraft.dev"
remote="https://${sourcecraft_host}/${SOURCECRAFT_REPO}.git"
# In CI the remote is fixed: an override injected into the job's environment must not redirect the push.
[ -n "${GITHUB_ACTIONS:-}" ] || remote="${SOURCECRAFT_GIT_URL:-$remote}"
org="${SOURCECRAFT_REPO%%/*}"
repo="${SOURCECRAFT_REPO#*/}"
source_repo="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-kyan9400/opsmind}"
source_sha="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

[ -f "$out/index.html" ] || { echo "$out/index.html not found: build the preview first" >&2; exit 1; }
# Copied over the new repository below, a .git in the site would replace its config and hooks.
[ ! -e "$out/.git" ] || { echo "$out/.git exists: refusing to publish a directory that carries git metadata" >&2; exit 1; }

# The token reaches git through a credential helper that reads the environment, so it never appears in
# a command line, a remote URL or .git/config. The helper answers only for https://git.sourcecraft.dev,
# so no other host git talks to can receive it. SourceCraft accepts any user name with a personal token.
export GIT_TERMINAL_PROMPT=0 SOURCECRAFT_TOKEN SOURCECRAFT_HOST="$sourcecraft_host"
# shellcheck disable=SC2016 # expanded by the helper's shell, not here
helper='!f() {
  [ "$1" = get ] || return 0
  while IFS== read -r key value; do
    case "$key" in protocol) protocol=$value ;; host) host=$value ;; esac
  done
  [ "${protocol:-}://${host:-}" = "https://${SOURCECRAFT_HOST}" ] || return 0
  echo username=opsmind-preview
  echo "password=${SOURCECRAFT_TOKEN}"
}; f'
git_() {
  git -c credential.helper= -c credential.helper="$helper" \
    -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    -c core.autocrlf=false "$@" # publish the built bytes as they are
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The Sites config only counts on the default branch. A repository created with a README may default to
# another name (e.g. master); an empty one has no HEAD yet, and the first branch pushed becomes the default.
head="$(git_ ls-remote --symref "$remote" HEAD | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2 }')"
main_branch="${SOURCECRAFT_MAIN_BRANCH:-${head:-main}}"
[ "$main_branch" != "$site_branch" ] || { echo "the site branch '$site_branch' is the default branch; set SOURCECRAFT_SITE_BRANCH" >&2; exit 1; }

sites_yaml() {
  cat <<EOF
# SourceCraft Sites configuration, written by deploy/sourcecraft/publish.sh from ${source_repo}.
# It is read from the default branch (${main_branch}) and publishes the files of branch "${site_branch}"
# (root: omitted, which means the repository root) at https://${org}.sourcecraft.site/${repo}/
site:
  ref: "${site_branch}"
EOF
}

# 1. Default branch: the Sites config (and a README), committed only when it changes. Pushed first, so a
#    brand-new empty repository gets it as its default branch rather than the site branch.
if [ -n "$(git_ ls-remote --heads "$remote" "$main_branch")" ]; then
  git_ clone -q --depth 1 --branch "$main_branch" "$remote" "$tmp/main"
else
  git_ init -q -b "$main_branch" "$tmp/main"
fi
mkdir -p "$tmp/main/.sourcecraft"
sites_yaml > "$tmp/main/.sourcecraft/sites.yaml"
[ -f "$tmp/main/README.md" ] || cat > "$tmp/main/README.md" <<EOF
# OpsMind — interactive preview

This repository only hosts the static interactive preview of OpsMind: the web UI with recorded data
and no server. It is published automatically from ${source_repo}; the site files live on the
\`${site_branch}\` branch, which every publish replaces. Please change the source repository, not this one.
EOF
git_ -C "$tmp/main" add -A
if git_ -C "$tmp/main" diff --cached --quiet 2>/dev/null; then
  echo "${main_branch}: Sites config unchanged"
else
  git_ -C "$tmp/main" commit -q -m "Configure SourceCraft Sites for the interactive preview"
  git_ -C "$tmp/main" push -q "$remote" "HEAD:refs/heads/${main_branch}"
  echo "${main_branch}: Sites config pushed"
fi

# 2. Site branch: exactly the built files in one new commit, force-pushed (a build output's history is noise).
git_ init -q -b "$site_branch" "$tmp/site"
cp -R "$out/." "$tmp/site/"
mkdir -p "$tmp/site/.sourcecraft"
sites_yaml > "$tmp/site/.sourcecraft/sites.yaml"
git_ -C "$tmp/site" add -A
git_ -C "$tmp/site" commit -q -m "Interactive preview built from ${source_repo}/commit/${source_sha}"
git_ -C "$tmp/site" push -q --force "$remote" "HEAD:refs/heads/${site_branch}"

url="https://${org}.sourcecraft.site/${repo}/"
echo "Published. SourceCraft updates the site within a few minutes: ${url}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "Interactive preview published to SourceCraft Sites: ${url} (it updates within a few minutes)" >> "$GITHUB_STEP_SUMMARY"
fi
