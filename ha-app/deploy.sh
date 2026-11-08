#!/usr/bin/env bash
# Deploy Lightesota as a local Home Assistant app on a Home Assistant OS box.
#
#   ha-app/deploy.sh [--host root@10.10.0.192] [--ref HEAD] [--seed-data ./data]
#
# Ships the repo at --ref (default: the current commit) to /local_apps/lightesota on the box,
# with ha-app/config.yaml at the folder's root, then has the Supervisor build and (re)start it.
# --seed-data copies a data folder to /share/lightesota on the box, only if nothing is there yet.
# Needs key-based SSH to the box's Terminal & SSH app.
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
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
APP=/local_apps/lightesota
SLUG=local_lightesota

stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
git archive --format=tar "$REF" | tar -x -C "$stage"
cp ha-app/config.yaml "$stage/config.yaml"
# The Supervisor scans the whole folder for config.* files, so the source copy must not ship
# or it is taken for a second app (in a folder without a Dockerfile).
rm "$stage/ha-app/config.yaml"
echo "$(git rev-parse --short "$REF") $(git log -1 --format=%s "$REF")" > "$stage/DEPLOYED"

if [ -n "$SEED" ]; then
  if "${SSH[@]}" "[ -e /share/lightesota/settings.json ]"; then
    echo "data already present on the box; not seeding"
  else
    echo "seeding /share/lightesota from $SEED"
    tar -C "$SEED" -c . | "${SSH[@]}" "mkdir -p /share/lightesota && tar -x --no-same-owner --no-same-permissions -C /share/lightesota"
  fi
fi

echo "shipping $(cat "$stage/DEPLOYED") to $HOST:$APP"
# Extract as root-owned, world-readable files: tar as root would otherwise keep the laptop uid and modes.
tar -C "$stage" -c . | "${SSH[@]}" "rm -rf $APP && mkdir -p $APP && tar -x --no-same-owner --no-same-permissions -C $APP && chmod 755 $APP"

echo "building on the box (this takes several minutes the first time)"
# "info" also answers for an app that is only in the store; an installed one has a version.
if "${SSH[@]}" "ha apps info $SLUG --raw-json 2>/dev/null | grep -q '\"version\":\"'"; then
  "${SSH[@]}" "ha store reload >/dev/null; ha apps rebuild --force $SLUG"
else
  "${SSH[@]}" "ha store reload >/dev/null; ha apps install $SLUG"
fi
"${SSH[@]}" "ha apps start $SLUG >/dev/null 2>&1 || true; sleep 3; ha apps info $SLUG | grep -E '^(state|version|host_network):'"
echo "done. Web app: http://${HOST#*@}:8787/"
