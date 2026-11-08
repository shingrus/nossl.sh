#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 (x86_64) VM to run the nossl Hatchet worker.
# Idempotent: safe to re-run; never overwrites an existing env file.
set -euo pipefail

RUN_AS="${RUN_AS:-nossl}"
APP_ROOT="${APP_ROOT:-/opt/nossl}"
BIN_DIR="${BIN_DIR:-$APP_ROOT/bin}"
REPO_DIR="${REPO_DIR:-$APP_ROOT/repo}"
REPO_URL="${REPO_URL:-https://github.com/shingrus/nossl.sh}"
REPO_REF="${REPO_REF:-main}"
DATA_DIR="${DATA_DIR:-/var/lib/nossl}"
ETC_DIR="${ETC_DIR:-/etc/nossl}"
ENV_FILE="${ENV_FILE:-$ETC_DIR/worker.env}"
SERVICE_NAME="${SERVICE_NAME:-nossl-worker}"
WORKER_BIN="${WORKER_BIN:-$BIN_DIR/nossl-worker}"
SWAP_SIZE="${SWAP_SIZE:-2G}" # set to 0 to skip swap creation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

warn() {
    log "warning: $*"
}

fail() {
    log "error: $*"
    exit 1
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        fail "run this script as root"
    fi
}

require_platform() {
    command -v apt-get >/dev/null 2>&1 || fail "apt-get not found; this script targets Ubuntu/Debian"
    [[ "$(uname -m)" == "x86_64" ]] || fail "unsupported architecture $(uname -m); x86_64 required"
    for template in "$SCRIPT_DIR/$SERVICE_NAME.env.example" "$SCRIPT_DIR/$SERVICE_NAME.service"; do
        [[ -f "$template" ]] || fail "missing template next to this script: $template"
    done
}

install_packages() {
    log "installing OS packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    # python3-* packages serve the not-yet-ported Python job scripts; drop them once
    # every job runs natively in the worker.
    apt-get install -y -q --no-install-recommends \
        ca-certificates \
        curl \
        git \
        mtr-tiny \
        dnsutils \
        libcap2-bin \
        sqlite3 \
        postgresql-client \
        python3 \
        python3-psycopg \
        python3-maxminddb
}

ensure_user() {
    if ! getent group "$RUN_AS" >/dev/null 2>&1; then
        log "creating group: $RUN_AS"
        groupadd --system "$RUN_AS"
    fi
    if ! id -u "$RUN_AS" >/dev/null 2>&1; then
        log "creating user: $RUN_AS"
        useradd --system --gid "$RUN_AS" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_AS"
    fi
}

install_layout() {
    log "creating directories"
    install -d -m 0755 -o root -g root "$APP_ROOT" "$BIN_DIR"
    install -d -m 0750 -o root -g "$RUN_AS" "$ETC_DIR"
    # Persistent state: never wiped between runs (geofeed-finder's cache must survive).
    install -d -m 0750 -o "$RUN_AS" -g "$RUN_AS" \
        "$DATA_DIR" \
        "$DATA_DIR/geofeed-cache" \
        "$DATA_DIR/repos" \
        "$DATA_DIR/pdbcache" \
        "$DATA_DIR/out"
}

ensure_mtr_raw_socket() {
    local mtr_packet
    mtr_packet="$(command -v mtr-packet || true)"
    [[ -n "$mtr_packet" ]] || fail "mtr-packet not found after installing mtr-tiny"
    if [[ -u "$mtr_packet" ]] || getcap "$mtr_packet" | grep -q cap_net_raw; then
        return
    fi
    log "granting cap_net_raw to $mtr_packet"
    setcap cap_net_raw+ep "$mtr_packet"
}

sync_repo() {
    if [[ -d "$REPO_DIR/.git" ]]; then
        log "updating repo $REPO_DIR to $REPO_REF"
        git -C "$REPO_DIR" fetch --depth 1 origin "$REPO_REF"
        git -C "$REPO_DIR" reset --hard FETCH_HEAD
    else
        log "cloning $REPO_URL ($REPO_REF) into $REPO_DIR"
        git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
    fi
}

ensure_swap() {
    if [[ "$SWAP_SIZE" == "0" ]]; then
        return
    fi
    if [[ -n "$(swapon --show --noheadings)" ]]; then
        return
    fi
    log "creating ${SWAP_SIZE} swapfile"
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

install_env_file() {
    if [[ -f "$ENV_FILE" ]]; then
        log "keeping existing $ENV_FILE"
        return
    fi
    log "installing env template: $ENV_FILE"
    install -m 0640 -o root -g "$RUN_AS" "$SCRIPT_DIR/$SERVICE_NAME.env.example" "$ENV_FILE"
}

install_service() {
    log "installing systemd unit: $SERVICE_NAME"
    install -m 0644 -o root -g root \
        "$SCRIPT_DIR/$SERVICE_NAME.service" \
        "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null
}

env_has_token() {
    grep -Eq '^HATCHET_CLIENT_TOKEN=.+' "$ENV_FILE"
}

maybe_start_service() {
    if [[ ! -x "$WORKER_BIN" ]]; then
        log "worker binary not installed yet ($WORKER_BIN); service enabled but not started"
        return
    fi
    if ! env_has_token; then
        log "HATCHET_CLIENT_TOKEN is empty in $ENV_FILE; service enabled but not started"
        return
    fi
    log "restarting $SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
}

smoke_checks() {
    log "running smoke checks as $RUN_AS"
    if ! runuser -u "$RUN_AS" -- mtr -n -r -c 1 1.1.1.1 >/dev/null 2>&1; then
        warn "mtr probe failed for $RUN_AS (check provider ICMP filtering and mtr-packet capability)"
    fi
    if [[ -z "$(dig +short +time=3 TXT 1.1.1.1.origin.asn.cymru.com)" ]]; then
        warn "Team Cymru DNS lookup returned nothing"
    fi
}

main() {
    require_root
    require_platform

    install_packages
    ensure_user
    install_layout
    ensure_mtr_raw_socket
    sync_repo
    ensure_swap
    install_env_file
    install_service
    maybe_start_service
    smoke_checks

    log "provisioning complete"
    log "next steps:"
    log "  1. Fill in secrets: sudoedit $ENV_FILE"
    log "  2. Install the worker binary at $WORKER_BIN"
    log "  3. Start it: systemctl restart $SERVICE_NAME && journalctl -u $SERVICE_NAME -f"
}

main "$@"
