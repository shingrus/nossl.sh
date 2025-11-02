#!/usr/bin/env bash
set -Eeuo pipefail

# ===== Config (override via env) =====
SERVICE="${SERVICE:-nossl}"
APP_DIR="${APP_DIR:-/opt/nossl.sh/app}"              # live app dir used by systemd service
RUN_AS="${RUN_AS:-nossl}"
REPO_URL="${REPO_URL:-https://github.com/shingrus/nossl.sh}"
BRANCH="${BRANCH:-main}"

# Health check
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/healthz}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-5}"                # seconds per attempt
HEALTH_RETRIES="${HEALTH_RETRIES:-8}"                # total attempts

# Build/install tuning
NODE_ENV="${NODE_ENV:-production}"
NPM_FLAGS="${NPM_FLAGS:---omit=dev}"                 # for npm ci (node>=9); fallback handled
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/var/cache/nossl-npm}"  # speeds installs; safe to keep

# Internal
as_user() { sudo -u "$RUN_AS" -H bash -lc "$*"; }
timestamp() { date +"%Y%m%d-%H%M%S"; }

# Prevent concurrent runs
exec 9>/var/lock/deploy-nossl.lock
flock -n 9 || { echo "Another deploy is running. Exiting."; exit 1; }

umask 022
sudo mkdir -p "$APP_DIR" "$NPM_CACHE_DIR"
sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR" "$NPM_CACHE_DIR"

# Ensure git is present & repo reachable at least once
if [[ ! -d "$APP_DIR/.git" && ! -d "$APP_DIR" ]]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"
fi

# Capture current revision (for rollback)
oldrev="unknown"
if [[ -d "$APP_DIR/.git" ]]; then
  oldrev="$(as_user "git -C '$APP_DIR' rev-parse --short HEAD" || echo 'unknown')"
fi

oldrev_full="$(as_user "git -C '$APP_DIR' rev-parse HEAD" 2>/dev/null || echo '')"
backup_dir="/opt/nossl.sh/backups/$(timestamp)-${oldrev:-unknown}"
tmp_release="/opt/nossl.sh/releases/release-$(timestamp)"

sudo mkdir -p "/opt/nossl.sh/releases" "/opt/nossl.sh/backups"
sudo chown -R "$RUN_AS:$RUN_AS" "/opt/nossl.sh/releases" "/opt/nossl.sh/backups"

echo "==> Preparing new release in: $tmp_release (branch: $BRANCH)"
as_user "git clone --depth=1 -b '$BRANCH' '$REPO_URL' '$tmp_release'"

newrev="$(as_user "git -C '$tmp_release' rev-parse --short HEAD")"
echo "==> New target commit: $newrev (was $oldrev)"

echo "==> Installing dependencies (offline cache: $NPM_CACHE_DIR)"
# Prefer clean install; fall back gracefully if older npm
if ! as_user "cd '$tmp_release' && npm ci $NPM_FLAGS --cache '$NPM_CACHE_DIR'"; then
  if ! as_user "cd '$tmp_release' && npm ci --production --cache '$NPM_CACHE_DIR'"; then
    as_user "cd '$tmp_release' && npm install --production --cache '$NPM_CACHE_DIR'"
  fi
fi

# Optional build if package.json has "build" script
if as_user "jq -er '.scripts.build? // empty' '$tmp_release/package.json' >/dev/null 2>&1 || \
            grep -q '\"build\"' '$tmp_release/package.json'"; then
  echo "==> Building"
  as_user "cd '$tmp_release' && NODE_ENV='$NODE_ENV' npm run -s build"
else
  echo "==> No build script detected, skipping build"
fi

# Preflight: basic runtime files present?
if [[ ! -f "$tmp_release/package.json" ]]; then
  echo "!! Build/prep failed: package.json missing in new release."
  exit 1
fi

# ===== Swap phase (short downtime) =====
echo "==> Stopping service: $SERVICE"
sudo systemctl stop "$SERVICE" || true

echo "==> Backing up current app to: $backup_dir"
if [[ -d "$APP_DIR" ]]; then
  # Move the entire directory to backup (fast, atomic at dir level)
  sudo mkdir -p "$backup_dir"
  sudo rsync -a --delete "$APP_DIR/"/ "$backup_dir/"/ || true
fi

echo "==> Deploying new release to live dir: $APP_DIR"
# Preserve ownership and permissions
sudo rsync -a --delete "$tmp_release/"/ "$APP_DIR/"/
sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"

echo "==> Starting service: $SERVICE"
sudo systemctl start "$SERVICE" || {
  echo "!! Failed to start service. Rolling back..."
  sudo rsync -a --delete "$backup_dir/"/ "$APP_DIR/"/
  sudo systemctl start "$SERVICE" || true
  exit 1
}

# ===== Health check & rollback =====
echo "==> Health check: $HEALTH_URL  (timeout=${HEALTH_TIMEOUT}s, retries=$HEALTH_RETRIES)"
ok=0
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" >/dev/null; then
    ok=1
    echo "Health check passed on attempt $i."
    break
  fi
  echo "Health check attempt $i failed; retrying..."
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "!! Health check FAILED after $HEALTH_RETRIES attempts. Rolling back to $oldrev."
  sudo systemctl stop "$SERVICE" || true
  if [[ -d "$backup_dir" ]]; then
    sudo rsync -a --delete "$backup_dir/"/ "$APP_DIR/"/
    sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"
  else
    echo "!! No backup found at $backup_dir — cannot rollback automatically."
  fi
  sudo systemctl start "$SERVICE" || true

  echo "==> Post-rollback health check"
  if curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" >/dev/null; then
    echo "Rollback succeeded and service is healthy."
    exit 2   # non-zero to indicate deployment failed but rollback ok
  else
    echo "!! Rollback health check failed. Manual intervention required."
    exit 3
  fi
fi

# ===== Success housekeeping =====
echo "==> Deployed commit: $newrev (previous $oldrev)"
systemctl status "$SERVICE" --no-pager -l | sed -n '1,12p'

# Cleanup old temp release
sudo rm -rf "$tmp_release" || true

exit 0
