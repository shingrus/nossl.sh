#!/usr/bin/env bash
set -Eeuo pipefail

# === Config (override via env) ===
SERVICE="${SERVICE:-nossl}"
APP_DIR="${APP_DIR:-/opt/nossl.sh/app}"
RUN_AS="${RUN_AS:-nossl}"
REPO_URL="${REPO_URL:-https://github.com/shingrus/nossl.sh}"

# === Helpers ===
as_user() { sudo -u "$RUN_AS" -H bash -lc "$*"; }

# Prevent concurrent runs
exec 9>/var/lock/deploy-nossl.lock
flock -n 9 || { echo "Another deploy is running. Exiting."; exit 1; }

# Ensure repo exists (first-time clone)
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"
  as_user "git clone '$REPO_URL' '$APP_DIR'"
fi

oldrev="$(as_user "git -C '$APP_DIR' rev-parse --short HEAD" || echo 'unknown')"
branch="$(as_user "git -C '$APP_DIR' rev-parse --abbrev-ref HEAD" || echo 'main')"

echo "==> Stopping service: $SERVICE"
sudo systemctl stop "$SERVICE" || true

echo "==> Updating code on branch: $branch"
as_user "git -C '$APP_DIR' fetch --prune --tags"
as_user "git -C '$APP_DIR' checkout -B '$branch' 'origin/$branch'"

echo '==> Installing dependencies'
# Prefer clean install; try omit=dev (npm>=9), then production, then install
if ! as_user "cd '$APP_DIR' && npm ci --omit=dev"; then
  if ! as_user "cd '$APP_DIR' && npm ci --production"; then
    as_user "cd '$APP_DIR' && npm install --production"
  fi
fi

# Optional build if script exists
if as_user "grep -q '\"build\"' '$APP_DIR/package.json'"; then
  echo '==> Running build'
  as_user "cd '$APP_DIR' && npm run -s build"
fi

echo "==> Starting service: $SERVICE"
if ! sudo systemctl start "$SERVICE"; then
  echo "!! Start failed — rolling back to $oldrev"
  as_user "git -C '$APP_DIR' reset --hard '$oldrev'"
  as_user "cd '$APP_DIR' && (npm ci --omit=dev || npm ci --production || npm install --production)"
  sudo systemctl start "$SERVICE"
fi

echo "==> Status (first lines):"
systemctl status "$SERVICE" --no-pager -l | sed -n '1,12p'

newrev="$(as_user "git -C '$APP_DIR' rev-parse --short HEAD")"
echo "==> Deployed commit: $newrev (was $oldrev) on branch $branch"
