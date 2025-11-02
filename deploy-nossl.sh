#!/usr/bin/env bash
set -Eeuo pipefail

# ===== Config (override via env) =====
SERVICE="${SERVICE:-nossl}"
APP_DIR="${APP_DIR:-/opt/nossl.sh/app}"                # live app dir used by systemd service
RUN_AS="${RUN_AS:-nossl}"
REPO_URL="${REPO_URL:-https://github.com/shingrus/nossl.sh}"
BRANCH="${BRANCH:-main}"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/healthz}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-5}"
HEALTH_RETRIES="${HEALTH_RETRIES:-8}"

NODE_ENV="${NODE_ENV:-production}"
NPM_FLAGS="${NPM_FLAGS:---omit=dev}"                   # for npm ci; fallback handled
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/var/cache/nossl-npm}" # speeds installs
export npm_config_build_from_source=false              # prefer prebuilt binaries

# ===== Helpers =====
as_user() { sudo -u "$RUN_AS" -H bash -lc "$*"; }
timestamp() { date +"%Y%m%d-%H%M%S"; }

# Prevent concurrent runs
exec 9>/var/lock/deploy-nossl.lock
flock -n 9 || { echo "Another deploy is running. Exiting."; exit 1; }

umask 022
sudo mkdir -p "$APP_DIR" "$NPM_CACHE_DIR" "/opt/nossl.sh/releases" "/opt/nossl.sh/backups"
sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR" "$NPM_CACHE_DIR" "/opt/nossl.sh/releases" "/opt/nossl.sh/backups"

# Capture old revision & metadata
oldrev="unknown"
[[ -d "$APP_DIR/.git" ]] && oldrev="$(as_user "git -C '$APP_DIR' rev-parse --short HEAD" || echo 'unknown')"
oldrev_full="$(as_user "git -C '$APP_DIR' rev-parse HEAD" 2>/dev/null || echo '')"

backup_dir="/opt/nossl.sh/backups/$(timestamp)-${oldrev:-unknown}"
tmp_release="/opt/nossl.sh/releases/release-$(timestamp)"
sudo chown -R "$RUN_AS:$RUN_AS" "/opt/nossl.sh/releases" "/opt/nossl.sh/backups"

echo "==> Preparing new release in: $tmp_release (branch: $BRANCH)"
as_user "git clone --depth=1 -b '$BRANCH' '$REPO_URL' '$tmp_release'"

newrev="$(as_user "git -C '$tmp_release' rev-parse --short HEAD")"
echo "==> New target commit: $newrev (previous $oldrev)"

# ===== Dependency strategy to AVOID rebuilding sqlite =====
# We reuse node_modules if BOTH lockfile hash and Node ABI match.
echo "==> Dependency preflight (lockfile + ABI)"
as_user "mkdir -p '$APP_DIR/.deploy' '$tmp_release/.deploy'"

# Compute lockfile hash for new release
new_lock_hash="$(as_user "test -f '$tmp_release/package-lock.json' && sha256sum '$tmp_release/package-lock.json' | awk '{print \$1}' || echo no-lockfile")"
# Capture Node ABI (must match or native addons break)
node_abi="$(as_user "node -p 'process.versions.modules' 2>/dev/null || echo unknown-abi")"

# Read current live metadata (if any)
old_lock_hash="$(as_user "cat '$APP_DIR/.deploy/package-lock.sha' 2>/dev/null || echo none")"
old_node_abi="$(as_user "cat '$APP_DIR/.deploy/node_abi' 2>/dev/null || echo none")"

reuse_modules=0
if [[ -d "$APP_DIR/node_modules" && "$new_lock_hash" == "$old_lock_hash" && "$node_abi" == "$old_node_abi" ]]; then
  reuse_modules=1
fi

if [[ "$reuse_modules" -eq 1 ]]; then
  echo "==> Reusing existing node_modules (lockfile & ABI match: $node_abi)"
  # Copy modules into the new release
  # rsync keeps perms and is much faster than reinstall
  as_user "rsync -a --delete '$APP_DIR/node_modules/' '$tmp_release/node_modules/'"
else
  echo "==> Installing dependencies (fresh) — reason:"
  [[ "$new_lock_hash" != "$old_lock_hash" ]] && echo "    - Lockfile changed ($old_lock_hash -> $new_lock_hash)"
  [[ "$node_abi" != "$old_node_abi" ]] && echo "    - Node ABI changed ($old_node_abi -> $node_abi)"
  echo "    - Or no prior node_modules to reuse"

  # Clean install with cache; fall back gracefully for older npm
  if ! as_user "cd '$tmp_release' && npm ci $NPM_FLAGS --cache '$NPM_CACHE_DIR'"; then
    if ! as_user "cd '$tmp_release' && npm ci --production --cache '$NPM_CACHE_DIR'"; then
      as_user "cd '$tmp_release' && npm install --production --cache '$NPM_CACHE_DIR'"
    fi
  fi
fi

# ===== Optional build =====
if as_user "jq -er '.scripts.build? // empty' '$tmp_release/package.json' >/dev/null 2>&1 || \
            grep -q '\"build\"' '$tmp_release/package.json'"; then
  echo "==> Building"
  as_user "cd '$tmp_release' && NODE_ENV='$NODE_ENV' npm run -s build"
else
  echo "==> No build script detected, skipping build"
fi

# Sanity check
[[ -f "$tmp_release/package.json" ]] || { echo "!! package.json missing in new release"; exit 1; }

# ===== Swap phase =====
echo "==> Stopping service: $SERVICE"
sudo systemctl stop "$SERVICE" || true

echo "==> Backing up current app to: $backup_dir"
if [[ -d "$APP_DIR" ]]; then
  sudo mkdir -p "$backup_dir"
  sudo rsync -a --delete "$APP_DIR/"/ "$backup_dir/"/ || true
fi

echo "==> Deploying new release to live dir: $APP_DIR"
sudo rsync -a --delete "$tmp_release/"/ "$APP_DIR/"/
sudo chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"

# Persist new metadata for future reuse decision
as_user "printf '%s' '$new_lock_hash' > '$APP_DIR/.deploy/package-lock.sha'"
as_user "printf '%s' '$node_abi' > '$APP_DIR/.deploy/node_abi'"

echo "==> Starting service: $SERVICE"
if ! sudo systemctl start "$SERVICE"; then
  echo "!! Start failed — rolling back to $oldrev"
  sudo rsync -a --delete "$backup_dir/"/ "$APP_DIR/"/
  sudo systemctl start "$SERVICE" || true
  exit 1
fi

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
    exit 2
  else
    echo "!! Rollback health check failed. Manual intervention required."
    exit 3
  fi
fi

echo "==> Deployed commit: $newrev (previous $oldrev)"
systemctl status "$SERVICE" --no-pager -l | sed -n '1,12p'

# Cleanup
sudo rm -rf "$tmp_release" || true
exit 0
