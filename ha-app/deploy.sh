#!/usr/bin/env bash
# Deploy Lightesota as a local Home Assistant app on a Home Assistant OS box.
#
#   ha-app/deploy.sh [--host root@10.10.0.192] [--ref HEAD] [--seed-data ./data]
#
# Ships the repo at --ref (default: the current commit) to /local_apps/lightesota on the box,
# with ha-app/config.yaml at the folder's root, then has the Supervisor build and (re)start it.
# --seed-data copies a data folder only when /share/lightesota does not exist.
# Previous source is retained under /share/lightesota-deployments, outside the Supervisor scan.
# Needs key-based SSH and an already verified known-host entry for the Terminal & SSH app.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="root@10.10.0.192"; REF="HEAD"; SEED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --seed-data) SEED="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$HOST" in -*|"") echo "invalid SSH host" >&2; exit 2 ;; esac
if [ -n "$SEED" ] && [ ! -d "$SEED" ]; then
  echo "seed data directory does not exist: $SEED" >&2
  exit 2
fi
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "$HOST")
APP=/local_apps/lightesota

# Resolve once: a moving branch must not mix source, manifest, and provenance from different commits.
COMMIT=$(git rev-parse --verify --end-of-options "${REF}^{commit}")
stage=$(mktemp -d "${TMPDIR:-/tmp}/lightesota-deploy.XXXXXX")
trap 'rm -rf "$stage"' EXIT
git archive --format=tar "$COMMIT" | tar -x -C "$stage"
# The Supervisor scans the whole folder for config.* files, so the source copy must not ship
# or it is taken for a second app (in a folder without a Dockerfile).
mv "$stage/ha-app/config.yaml" "$stage/config.yaml"
test -f "$stage/Dockerfile"
printf '%s %s\n' "$COMMIT" "$(git log -1 --format=%s "$COMMIT")" > "$stage/DEPLOYED"

if [ -n "$SEED" ]; then
  # Check and copy in one SSH command; an SSH failure must never be mistaken for missing data.
  seed_command=$(cat <<'REMOTE'
set -eu
data=/share/lightesota
if [ -e "$data" ] || [ -L "$data" ]; then
  cat >/dev/null
  echo "data directory already present on the box; not seeding"
else
  # mkdir fails if another process creates the directory, so existing data cannot be overwritten.
  mkdir "$data"
  tar -x --no-same-owner --no-same-permissions -C "$data"
fi
REMOTE
)
  tar -C "$SEED" -c . | "${SSH[@]}" "$seed_command"
fi

echo "shipping $(cat "$stage/DEPLOYED") to $HOST:$APP"
# Extract as root-owned, world-readable files: tar as root would otherwise keep the laptop uid and modes.
ship_command=$(cat <<'REMOTE'
set -eu
umask 022
app=/local_apps/lightesota
mkdir -p /local_apps
incoming=$(mktemp -d /local_apps/.lightesota-incoming.XXXXXX)
trap 'if [ -n "$incoming" ]; then rm -rf "$incoming"; fi' EXIT
tar -x --no-same-owner --no-same-permissions -C "$incoming"
test -f "$incoming/config.yaml"
test -f "$incoming/Dockerfile"
test ! -e "$incoming/ha-app/config.yaml"
chmod 755 "$incoming"
backup=""
if [ -e "$app" ] || [ -L "$app" ]; then
  mkdir -p /share/lightesota-deployments
  backup=$(mktemp -d /share/lightesota-deployments/previous-source.XXXXXX)
  mv "$app" "$backup/source"
  echo "previous source retained at $backup/source"
fi
if mv "$incoming" "$app"; then
  incoming=""
else
  if [ -n "$backup" ]; then mv "$backup/source" "$app"; fi
  exit 1
fi
REMOTE
)
tar -C "$stage" -c . | "${SSH[@]}" "$ship_command"

echo "building on the box (this takes several minutes the first time)"
# Any failed reload, build, start, or status check stops here; the previous source remains available.
build_command=$(cat <<'REMOTE'
set -eu
slug=local_lightesota
ha store reload >/dev/null
# "info" also answers for an app that is only in the store; an installed one has a version.
info=$(ha apps info "$slug" --raw-json)
if printf '%s\n' "$info" | grep -q '"version"[[:space:]]*:[[:space:]]*"'; then
  ha apps rebuild --force "$slug"
else
  ha apps install "$slug"
fi
info=$(ha apps info "$slug" --raw-json)
if ! printf '%s\n' "$info" | grep -q '"state"[[:space:]]*:[[:space:]]*"started"'; then
  ha apps start "$slug"
fi
sleep 3
info=$(ha apps info "$slug" --raw-json)
printf '%s\n' "$info" | grep -q '"state"[[:space:]]*:[[:space:]]*"started"'
ha apps info "$slug" | grep -E '^(state|version|host_network):'
REMOTE
)
"${SSH[@]}" "$build_command"
echo "done. Web app: http://${HOST#*@}:8787/"
